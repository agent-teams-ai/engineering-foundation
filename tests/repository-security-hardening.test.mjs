import {
  ACTION_SHA,
  DEPENDENCY_REVIEW_SHA,
  SBOM_SHA,
  REUSABLE_WORKFLOW_SHA,
  CONTAINER_DIGEST,
  JOB_CONTAINER_IMAGE,
  SERVICE_CONTAINER_IMAGE,
  COMPOSITE_ACTION_SHA,
  TRANSITIVE_ACTION_SHA,
  ACTIONLINT_RUNNER_SHA,
  UNTRUSTED_SHA,
  UNUSED_SHA,
  ZIZMOR_RUNNER_SHA,
  TOOL_CONFIGS,
  ciWorkflow,
  compositeAction,
} from "./support/security-workflow-fixture.ts";
import { registerSecurityObservationPortTests } from "./support/security-observation-ports.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parse as parseYaml } from "yaml";
import { sha256, digestWorkflows } from "./support/repository-security-digests.mjs";
import { repositorySourceRoot } from "./support/repository-source.ts";

registerSecurityObservationPortTests();

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repositoryRoot, "packages", "engineering-foundation", "dist", "cli.js");

function allowedUse(uses, transitiveUses = []) {
  return { uses, transitiveUses };
}

const ALLOWED_USES = [
  allowedUse(`actions/checkout@${ACTION_SHA}`),
  allowedUse(`actions/dependency-review-action@${DEPENDENCY_REVIEW_SHA}`),
  allowedUse(`anchore/sbom-action@${SBOM_SHA}`),
  allowedUse(`docker://ghcr.io/example/workflow-tool@sha256:${CONTAINER_DIGEST}`),
  allowedUse(`example/inside-composite@${COMPOSITE_ACTION_SHA}`),
  allowedUse(`example/actionlint-runner@${ACTIONLINT_RUNNER_SHA}`),
  allowedUse(`example/zizmor-runner@${ZIZMOR_RUNNER_SHA}`),
  allowedUse(`example/reusable/.github/workflows/release.yml@${REUSABLE_WORKFLOW_SHA}`, [
    allowedUse(`example/transitive-action@${TRANSITIVE_ACTION_SHA}`),
  ]),
];

function toolEvidenceConfig({
  actionlintInvocationUse,
  actionlintRollout = "blocking",
  includeTools,
}) {
  if (!includeTools) {
    return "";
  }
  return [
    "toolEvidence:",
    "  actionlint:",
    `    configPath: ${TOOL_CONFIGS.actionlint.configPath}`,
    `    evidencePath: ${TOOL_CONFIGS.actionlint.evidencePath}`,
    `    invocationUse: ${actionlintInvocationUse ?? TOOL_CONFIGS.actionlint.invocationUse}`,
    `    jobId: ${TOOL_CONFIGS.actionlint.jobId}`,
    `    resultPath: ${TOOL_CONFIGS.actionlint.resultPath}`,
    `    rollout: ${actionlintRollout}`,
    `    version: ${TOOL_CONFIGS.actionlint.version}`,
    `    workflowPath: ${TOOL_CONFIGS.actionlint.workflowPath}`,
    "  zizmor:",
    `    configPath: ${TOOL_CONFIGS.zizmor.configPath}`,
    `    evidencePath: ${TOOL_CONFIGS.zizmor.evidencePath}`,
    `    invocationUse: ${TOOL_CONFIGS.zizmor.invocationUse}`,
    `    jobId: ${TOOL_CONFIGS.zizmor.jobId}`,
    `    resultPath: ${TOOL_CONFIGS.zizmor.resultPath}`,
    "    rollout: blocking",
    `    version: ${TOOL_CONFIGS.zizmor.version}`,
    `    workflowPath: ${TOOL_CONFIGS.zizmor.workflowPath}`,
    "",
  ].join("\n");
}

function allowedUseYaml(entries, indent) {
  const lines = [];
  for (const entry of entries) {
    lines.push(`${indent}- uses: ${entry.uses}`);
    if (entry.transitiveUses.length === 0) {
      lines.push(`${indent}  transitiveUses: []`);
    } else {
      lines.push(`${indent}  transitiveUses:`);
      lines.push(...allowedUseYaml(entry.transitiveUses, `${indent}    `));
    }
  }
  return lines;
}

function capabilityConfig({
  allowedContainerImages,
  allowedPullRequestTargetWorkflows = [],
  allowedUses,
  actionlintInvocationUse,
  actionlintRollout,
  includeTools,
}) {
  return [
    "schemaVersion: 1",
    "workflowDirectory: .github/workflows",
    "dependencyReview:",
    "  workflowPath: .github/workflows/ci.yml",
    "  jobId: dependency-review",
    "  baseRef: refs/heads/main",
    "  headRef: refs/pull/current/head",
    "  failOnSeverity: moderate",
    "sbomWorkflow: .github/workflows/ci.yml",
    ...(allowedContainerImages.length === 0
      ? ["allowedContainerImages: []"]
      : ["allowedContainerImages:", ...allowedContainerImages.map((image) => `  - ${image}`)]),
    ...(allowedPullRequestTargetWorkflows.length === 0
      ? ["allowedPullRequestTargetWorkflows: []"]
      : [
          "allowedPullRequestTargetWorkflows:",
          ...allowedPullRequestTargetWorkflows.map((path) => `  - ${path}`),
        ]),
    "privilegedJobs: []",
    "publishablePackageManifests:",
    "  - packages/library/package.json",
    "allowedUses:",
    ...allowedUseYaml(allowedUses, "  "),
    toolEvidenceConfig({ actionlintInvocationUse, actionlintRollout, includeTools }),
  ]
    .filter((entry) => entry !== "")
    .join("\n");
}

async function writeRepositoryFile(root, path, source) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source, "utf8");
}

async function writeToolEvidence(root, tool, workflows, options = {}) {
  const config = TOOL_CONFIGS[tool];
  const result = `{"tool":"${tool}","diagnostics":[]}\n`;
  await writeRepositoryFile(root, config.configPath, `rules: []\n`);
  await writeRepositoryFile(root, config.resultPath, result);
  const configDigest = sha256(await readFile(join(root, config.configPath)));
  const workflowDigest = options.workflowDigest ?? digestWorkflows(workflows);
  await writeRepositoryFile(
    root,
    config.evidencePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        tool,
        toolVersion: options.toolVersion ?? config.version,
        configDigest,
        workflowDigest,
        resultDigest: sha256(result),
        outcome: options.outcome ?? "passed",
      },
      null,
      2,
    )}\n`,
  );
}

async function withConsumer(options, callback) {
  const root = await mkdtemp(join(tmpdir(), "foundation-repository-security-hardening-"));
  const workflows = {
    ".github/workflows/ci.yml": ciWorkflow({
      actionlintNonBlocking:
        options.actionlintNonBlocking ?? options.actionlintRollout === "advisory",
      actionlintStepConditional: options.actionlintStepConditional,
      actionlintStepNonBlocking: options.actionlintStepNonBlocking,
      dependencyReview: options.dependencyReview ?? true,
      extraStep: options.extraStep,
      installBeforeDependencyReview: options.installBeforeDependencyReview,
      jobContainerImage: options.jobContainerImage,
      pullRequest: options.pullRequest,
      serviceContainerImage: options.serviceContainerImage,
    }),
    ".github/actions/checked-in-action/action.yml": compositeAction(
      options.compositeUse ?? `example/inside-composite@${COMPOSITE_ACTION_SHA}`,
      options.compositeRun,
    ),
    ...options.additionalWorkflows,
  };
  try {
    await writeRepositoryFile(
      root,
      "foundation.config.yaml",
      [
        "schemaVersion: 1",
        "project:",
        "  id: repository-security-hardening",
        "capabilities:",
        "  repository.security-baseline:",
        "    configPath: architecture/foundation/repository-security-baseline.yaml",
        "",
      ].join("\n"),
    );
    for (const [path, source] of Object.entries(workflows)) {
      await writeRepositoryFile(root, path, source);
    }
    await writeRepositoryFile(
      root,
      "packages/library/package.json",
      `${JSON.stringify(
        {
          name: "@fixture/library",
          version: "1.0.0",
          files: ["dist", "README.md"],
          publishConfig: { provenance: true },
        },
        null,
        2,
      )}\n`,
    );
    await writeRepositoryFile(
      root,
      "architecture/foundation/repository-security-baseline.yaml",
      `${capabilityConfig({
        allowedContainerImages: options.allowedContainerImages ?? [],
        allowedPullRequestTargetWorkflows: options.allowedPullRequestTargetWorkflows,
        allowedUses: options.allowedUses ?? ALLOWED_USES,
        actionlintInvocationUse: options.actionlintInvocationUse,
        actionlintRollout: options.actionlintRollout,
        includeTools: options.includeTools ?? false,
      })}\n`,
    );
    if (options.includeTools) {
      await writeToolEvidence(root, "actionlint", workflows, options.actionlintEvidence);
      await writeToolEvidence(root, "zizmor", workflows, options.zizmorEvidence);
    }
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function runCheck(consumerRoot) {
  const result = spawnSync(
    process.execPath,
    [cliPath, "check", "--consumer", consumerRoot, "--format", "json"],
    { encoding: "utf8" },
  );
  assert.equal(result.stderr, "");
  return { result, report: JSON.parse(result.stdout) };
}

function securityDiagnostics(report) {
  return report.capabilities[0].diagnostics;
}

test("allows a private or offline consumer to omit optional hosted CodeQL evidence", async () => {
  await withConsumer({ includeTools: true }, async (consumerRoot) => {
    const { result, report } = runCheck(consumerRoot);
    assert.equal(result.status, 0);
    assert.equal(report.outcome, "passed");
    assert.deepEqual(securityDiagnostics(report), []);
  });
});

test("requires Dependency Review in the declared required CI workflow", async () => {
  await withConsumer(
    {
      allowedUses: ALLOWED_USES.filter(
        ({ uses }) => uses !== `actions/dependency-review-action@${DEPENDENCY_REVIEW_SHA}`,
      ),
      dependencyReview: false,
      includeTools: false,
    },
    async (consumerRoot) => {
      const { result, report } = runCheck(consumerRoot);
      assert.equal(result.status, 1);
      assert.deepEqual(
        securityDiagnostics(report).map(({ ruleId }) => ruleId),
        ["repository.security-baseline.dependency-review-missing"],
      );
      // The Linux CI driver must reject an actual non-SDK failure before archive acquisition.
      if (process.platform === "linux") {
        const ci = parseYaml(
          await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
        );
        const step = ci.jobs["linux-static"].steps.find(
          (candidate) => candidate.id === "foundation-check",
        );
        assert.match(
          step.run,
          /node scripts\/public-api-native-migration-cli\.ts qualify --ordinary-report "\$RUNNER_TEMP\/foundation-check\.json" --migration-report "\$RUNNER_TEMP\/native-api-migration\.json"/u,
        );
        const { qualifyOrdinaryResult } =
          await import("../scripts/public-api-native-migration-cli.ts");
        let acquired = false;
        const original = { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
        await assert.rejects(
          qualifyOrdinaryResult(original, async () => {
            acquired = true;
            assert.fail("an unrelated security failure must not acquire migration archives");
          }),
          /ordinary full report is not the exact retained mismatch result/u,
        );
        assert.equal(acquired, false);
        assert.deepEqual(original, { stdout: result.stdout, stderr: result.stderr, exitCode: 1 });
      }
    },
  );
});

test("rejects pull-request package installs that can run before Dependency Review", async () => {
  await withConsumer(
    { includeTools: false, installBeforeDependencyReview: true },
    async (consumerRoot) => {
      const { result, report } = runCheck(consumerRoot);
      assert.equal(result.status, 1);
      assert.deepEqual(
        securityDiagnostics(report).map(({ ruleId }) => ruleId),
        ["repository.security-baseline.dependency-review-ordering"],
      );
    },
  );
});

test("allows only an explicitly reviewed pull_request_target workflow path", async () => {
  const workflowPath = ".github/workflows/reviewrouter.yml";
  const workflow = [
    "name: ReviewRouter",
    "on:",
    "  pull_request_target:",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  review:",
    "    runs-on: ubuntu-24.04",
    "    steps: []",
    "",
  ].join("\n");
  await withConsumer(
    {
      additionalWorkflows: { [workflowPath]: workflow },
      allowedPullRequestTargetWorkflows: [workflowPath],
      includeTools: false,
    },
    async (consumerRoot) => {
      const { result, report } = runCheck(consumerRoot);
      assert.equal(result.status, 0);
      assert.deepEqual(securityDiagnostics(report), []);
    },
  );
});

test("rejects a stale pull_request_target workflow declaration", async () => {
  await withConsumer(
    {
      allowedPullRequestTargetWorkflows: [".github/workflows/missing-reviewrouter.yml"],
      includeTools: false,
    },
    async (consumerRoot) => {
      const { result, report } = runCheck(consumerRoot);
      assert.equal(result.status, 1);
      assert.deepEqual(
        securityDiagnostics(report).map(({ ruleId }) => ruleId),
        ["repository.security-baseline.stale-pull-request-target-workflow"],
      );
    },
  );
});

test("repository CI preserves admitted runtime security scans and Node qualification gates", async () => {
  const sourceRoot = await repositorySourceRoot();
  const [
    workflow,
    manifest,
    policy,
    runtimeBytes,
    { TOOL_COMMANDS },
    profileDriver,
    securityToolchain,
  ] = await Promise.all([
    readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8"),
    readFile(join(sourceRoot, "package.json"), "utf8"),
    readFile(
      join(repositoryRoot, "architecture/foundation/repository-security-baseline.yaml"),
      "utf8",
    ),
    readFile(join(repositoryRoot, "architecture/foundation/repository-runtime.json"), "utf8"),
    import("../tools/repository-tool-catalog.ts"),
    readFile(join(repositoryRoot, "tools/dev.mts"), "utf8"),
    readFile(join(repositoryRoot, "scripts/security-toolchain.mjs"), "utf8"),
  ]);
  const scripts = JSON.parse(manifest).scripts;
  const ci = parseYaml(workflow);

  assert.match(
    ci.jobs["dependency-review"].steps[1].uses,
    /^actions\/dependency-review-action@[a-f0-9]{40}$/u,
  );
  assert.deepEqual(ci.jobs["macos-qualification"].needs, [
    "dependency-review",
    "macos-native",
    "macos-package",
  ]);
  const macosSteps = ci.jobs["macos-native"].steps;
  assert.ok(macosSteps.some(({ run }) => run === "bun tools/dev.mts test:qgr:lifecycle:built"));
  const macosMutationQualification = macosSteps.find(
    ({ name }) => name === "Qualify repository mutation, scaffolding, and durable document writing",
  )?.run;
  assert.match(
    macosMutationQualification,
    /tests\/known-file-transaction-node\.test\.mjs[\s\S]*tests\/known-file-transaction-plan\.test\.mjs[\s\S]*tests\/scaffolding-recovery-scope\.test\.mjs/u,
  );
  for (const [jobId, job] of Object.entries(ci.jobs)) {
    if (jobId === "dependency-review") {
      continue;
    }
    assert.ok(
      Array.isArray(job.needs)
        ? job.needs.includes("dependency-review")
        : job.needs === "dependency-review",
      `${jobId} must depend directly on dependency-review`,
    );
  }
  const staticSteps = ci.jobs["linux-static"].steps;
  const installIndex = staticSteps.findIndex(({ run }) => run === "bun tools/dev.mts install");
  const buildIndex = staticSteps.findIndex(({ run }) => run === "bun tools/dev.mts build");
  const securityIndex = staticSteps.findIndex(
    ({ run }) => run === "bun tools/dev.mts security:workflows",
  );
  assert.ok(installIndex > 0 && buildIndex > installIndex && securityIndex > buildIndex);
  assert.ok(
    staticSteps
      .slice(0, installIndex)
      .some(
        ({ uses, with: options }) =>
          uses?.startsWith("actions/setup-node@") &&
          options?.["node-version-file"] === ".node-version",
      ),
  );
  assert.ok(
    staticSteps
      .slice(0, installIndex)
      .some(
        ({ uses, with: options }) =>
          uses?.startsWith("oven-sh/setup-bun@") && options?.["bun-version"] === "1.4.3",
      ),
  );
  const runtime = JSON.parse(runtimeBytes);
  assert.equal(JSON.parse(manifest).packageManager, "bun@1.4.3");
  assert.equal(runtime.defaultProfile, "bun");
  assert.deepEqual(runtime.profiles.node, { manager: "pnpm", runtime: "node" });
  assert.equal(runtime.install.dependencyScripts, false);
  assert.deepEqual(runtime.install.nativeInitialization, ["@ast-grep/cli", "nx"]);
  assert.deepEqual(runtime.install.disabledDependencyScripts, ["esbuild"]);
  assert.match(
    profileDriver,
    /\["install", "--frozen-lockfile", "--ignore-scripts", "--linker=isolated"\]/u,
  );
  assert.match(
    profileDriver,
    /\["install", "--frozen-lockfile", "--ignore-scripts", "--engine-strict"\]/u,
  );
  assert.match(
    profileDriver,
    /const qualified = await run\([\s\S]*?tools\.node,[\s\S]*?qualify-native-tools\.mts[\s\S]*?qualified === 0[\s\S]*?dependencies-installed-check\.mts/u,
  );
  const compatibilitySteps = ci.jobs["node26-compatibility"].steps;
  const projectionInstall = compatibilitySteps.find(
    ({ run }) => run === "node tools/dev.mts --profile node install",
  );
  assert.equal(projectionInstall?.env.AGENT_TEAMS_FOUNDATION_SOURCE_SHA, "${{ github.sha }}");
  assert.ok(
    compatibilitySteps.some(
      ({ run, "working-directory": cwd }) =>
        run === "pnpm dependencies:peers:check" &&
        cwd === ".worker-tmp/profiles/node-${{ github.sha }}",
    ),
  );
  const securityPolicy = parseYaml(policy);
  assert.equal(securityPolicy.dependencyReview.workflowPath, ".github/workflows/pr-feedback.yml");
  assert.equal(securityPolicy.sbomWorkflow, ".github/workflows/pr-feedback.yml");
  assert.equal(
    scripts["security:workflows"],
    "node tools/repository-command.mts tool security:workflows",
  );
  const { TOOL_COMMANDS } = await import("../tools/repository-tool-catalog.ts");
  assert.deepEqual(TOOL_COMMANDS["security:workflows"], {
    entry: "scripts/security-toolchain.mjs",
    args: [],
    role: "runtime",
  });
  assert.deepEqual(TOOL_COMMANDS["test:qgr:lifecycle:built"], {
    entry: "scripts/run-selected-tests.mjs",
    args: [
      "tests/quality-gate-runner.test.mjs",
      "tests/quality-gate-runner-lifecycle.test.mjs",
      "tests/quality-gate-runner-real-pnpm-lifecycle.test.mjs",
      "tests/quality-gate-runner-remediation.test.mjs",
    ],
    role: "node-qualification",
  });
  assert.match(dispatcher, /from "\.\/repository-tool-catalog\.ts"/u);
  assert.match(dispatcher, /TOOL_COMMANDS\[id\]/u);
  assert.match(dispatcher, /paths\.length > 0 && command\.acceptsPaths !== true/u);
  assert.match(securityToolchain, /\["exec", "--", "actionlint"\]/u);
  assert.match(
    securityToolchain,
    /"zizmor",[\s\S]*?"--offline",[\s\S]*?"--strict-collection",[\s\S]*?"\."\s*,?\s*\]/u,
  );
  assert.equal(
    ci.jobs.check.if,
    "${{ always() && (github.event_name != 'pull_request' || (github.event.label.name == 'ci:full' || startsWith(github.event.label.name, 'ci:full:'))) }}",
  );
  assert.match(ci.jobs.check.steps[0].uses, /^re-actors\/alls-green@[a-f0-9]{40}$/u);
  assert.doesNotMatch(workflow, /aquaproj\/aqua-installer/u);
  assert.doesNotMatch(policy, /aquaproj\/aqua-installer/u);
});

test("rejects mutable job containers and unallowlisted service containers", async () => {
  await withConsumer(
    {
      includeTools: false,
      jobContainerImage: "ghcr.io/example/build:latest",
      serviceContainerImage: SERVICE_CONTAINER_IMAGE,
    },
    async (consumerRoot) => {
      const { result, report } = runCheck(consumerRoot);
      assert.equal(result.status, 1);
      assert.deepEqual(
        new Set(securityDiagnostics(report).map(({ ruleId }) => ruleId)),
        new Set([
          "repository.security-baseline.container-not-allowlisted",
          "repository.security-baseline.container-not-pinned",
        ]),
      );
    },
  );
});

test("rejects stale container-image trust declarations", async () => {
  await withConsumer(
    {
      allowedContainerImages: [JOB_CONTAINER_IMAGE],
      includeTools: false,
    },
    async (consumerRoot) => {
      const { result, report } = runCheck(consumerRoot);
      assert.equal(result.status, 1);
      assert.deepEqual(
        securityDiagnostics(report).map(({ ruleId }) => ruleId),
        ["repository.security-baseline.stale-allowed-container-image"],
      );
    },
  );
});

test("rejects direct event interpolation inside checked-in composite actions", async () => {
  await withConsumer(
    {
      compositeRun: "echo ${{ github.event.pull_request.title }}",
      includeTools: false,
    },
    async (consumerRoot) => {
      const { result, report } = runCheck(consumerRoot);
      assert.equal(result.status, 1);
      assert.deepEqual(
        securityDiagnostics(report).map(({ ruleId }) => ruleId),
        ["repository.security-baseline.event-interpolation-in-run"],
      );
      assert.equal(
        securityDiagnostics(report)[0].location.path,
        ".github/actions/checked-in-action/action.yml",
      );
    },
  );
});

test("rejects a trusted SHA reference that is absent from allowedUses", async () => {
  await withConsumer(
    {
      includeTools: false,
      extraStep: `      - uses: example/unreviewed@${UNTRUSTED_SHA}`,
    },
    async (consumerRoot) => {
      const { result, report } = runCheck(consumerRoot);
      assert.equal(result.status, 1);
      assert.deepEqual(
        securityDiagnostics(report).map(({ ruleId }) => ruleId),
        ["repository.security-baseline.action-not-allowlisted"],
      );
    },
  );
});

test("rejects an unallowlisted action reached through a checked-in composite action", async () => {
  await withConsumer(
    {
      compositeUse: `example/unreviewed@${UNTRUSTED_SHA}`,
      includeTools: false,
      allowedUses: ALLOWED_USES.filter(
        ({ uses }) => uses !== `example/inside-composite@${COMPOSITE_ACTION_SHA}`,
      ),
    },
    async (consumerRoot) => {
      const { result, report } = runCheck(consumerRoot);
      assert.equal(result.status, 1);
      assert.deepEqual(
        securityDiagnostics(report).map(({ ruleId }) => ruleId),
        ["repository.security-baseline.action-not-allowlisted"],
      );
      assert.equal(
        securityDiagnostics(report)[0].location.path,
        ".github/actions/checked-in-action/action.yml",
      );
    },
  );
});

test("rejects local Node and Docker actions until their runtime evidence is governed", async () => {
  await withConsumer({ includeTools: false }, async (consumerRoot) => {
    await writeRepositoryFile(
      consumerRoot,
      ".github/actions/checked-in-action/action.yml",
      "name: Opaque local action\nruns:\n  using: node24\n  main: dist/index.js\n",
    );
    const { result, report } = runCheck(consumerRoot);
    assert.equal(result.status, 2);
    assert.equal(
      report.capabilities[0].problem.code,
      "REPOSITORY_SECURITY_LOCAL_ACTION_RUNTIME_UNSUPPORTED",
    );
  });
});

test("rejects a stale allowedUses entry", async () => {
  await withConsumer(
    {
      includeTools: false,
      allowedUses: [...ALLOWED_USES, allowedUse(`example/unused@${UNUSED_SHA}`)],
    },
    async (consumerRoot) => {
      const { result, report } = runCheck(consumerRoot);
      assert.equal(result.status, 1);
      assert.deepEqual(
        securityDiagnostics(report).map(({ ruleId }) => ruleId),
        ["repository.security-baseline.stale-allowed-use"],
      );
    },
  );
});

test("requires independent actionlint evidence", async () => {
  await withConsumer({ includeTools: true }, async (consumerRoot) => {
    await unlink(join(consumerRoot, TOOL_CONFIGS.actionlint.evidencePath));
    const { result, report } = runCheck(consumerRoot);
    assert.equal(result.status, 1);
    assert.deepEqual(
      securityDiagnostics(report).map(({ ruleId }) => ruleId),
      ["repository.security-baseline.tool-evidence-missing"],
    );
    assert.equal(securityDiagnostics(report)[0].subject, "actionlint");
  });
});

test("rejects a failed zizmor evidence envelope", async () => {
  await withConsumer(
    { includeTools: true, zizmorEvidence: { outcome: "failed" } },
    async (consumerRoot) => {
      const { result, report } = runCheck(consumerRoot);
      assert.equal(result.status, 1);
      assert.deepEqual(
        securityDiagnostics(report).map(({ ruleId }) => ruleId),
        ["repository.security-baseline.tool-evidence-failed"],
      );
      assert.equal(securityDiagnostics(report)[0].subject, "zizmor");
    },
  );
});

test("requires a blocking actionlint declaration to target a blocking external CI job", async () => {
  await withConsumer({ actionlintNonBlocking: true, includeTools: true }, async (consumerRoot) => {
    const { result, report } = runCheck(consumerRoot);
    assert.equal(result.status, 1);
    assert.deepEqual(
      securityDiagnostics(report).map(({ ruleId }) => ruleId),
      ["repository.security-baseline.tool-evidence-rollout-mismatch"],
    );
  });
});

test("requires a blocking actionlint invocation to be unconditional", async () => {
  await withConsumer(
    { actionlintStepConditional: true, includeTools: true },
    async (consumerRoot) => {
      const { result, report } = runCheck(consumerRoot);
      assert.equal(result.status, 1);
      assert.deepEqual(
        securityDiagnostics(report).map(({ ruleId }) => ruleId),
        ["repository.security-baseline.tool-evidence-invocation-missing"],
      );
    },
  );
});

test("requires a blocking actionlint invocation to fail the job", async () => {
  await withConsumer(
    { actionlintStepNonBlocking: true, includeTools: true },
    async (consumerRoot) => {
      const { result, report } = runCheck(consumerRoot);
      assert.equal(result.status, 1);
      assert.deepEqual(
        securityDiagnostics(report).map(({ ruleId }) => ruleId),
        ["repository.security-baseline.tool-evidence-invocation-missing"],
      );
    },
  );
});

test("requires a blocking external tool job to run for every pull request", async () => {
  await withConsumer({ includeTools: true, pullRequest: false }, async (consumerRoot) => {
    const { result, report } = runCheck(consumerRoot);
    assert.equal(result.status, 1);
    assert.ok(
      securityDiagnostics(report).some(
        ({ ruleId }) => ruleId === "repository.security-baseline.tool-evidence-rollout-mismatch",
      ),
    );
  });
});

test("binds actionlint evidence to the reviewed invocation in its declared CI job", async () => {
  await withConsumer(
    {
      actionlintInvocationUse: `actions/checkout@${ACTION_SHA}`,
      includeTools: true,
    },
    async (consumerRoot) => {
      const { result, report } = runCheck(consumerRoot);
      assert.equal(result.status, 1);
      assert.deepEqual(
        securityDiagnostics(report).map(({ ruleId }) => ruleId),
        ["repository.security-baseline.tool-evidence-invocation-missing"],
      );
    },
  );
});

test("rejects stale actionlint evidence when the observed workflow digest differs", async () => {
  await withConsumer(
    {
      includeTools: true,
      actionlintEvidence: { workflowDigest: `sha256:${"0".repeat(64)}` },
    },
    async (consumerRoot) => {
      const { result, report } = runCheck(consumerRoot);
      assert.equal(result.status, 1);
      assert.deepEqual(
        securityDiagnostics(report).map(({ ruleId }) => ruleId),
        ["repository.security-baseline.tool-evidence-stale"],
      );
      assert.equal(securityDiagnostics(report)[0].subject, "actionlint");
    },
  );
});

test("rejects actionlint evidence from a different pinned version", async () => {
  await withConsumer(
    { includeTools: true, actionlintEvidence: { toolVersion: "1.7.6" } },
    async (consumerRoot) => {
      const { result, report } = runCheck(consumerRoot);
      assert.equal(result.status, 1);
      assert.deepEqual(
        securityDiagnostics(report).map(({ ruleId }) => ruleId),
        ["repository.security-baseline.tool-evidence-version-mismatch"],
      );
    },
  );
});

test("rejects actionlint evidence when its opaque tool config changed after execution", async () => {
  await withConsumer({ includeTools: true }, async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, TOOL_CONFIGS.actionlint.configPath),
      "rules:\n  - changed-after-evidence\n",
      "utf8",
    );
    const { result, report } = runCheck(consumerRoot);
    assert.equal(result.status, 1);
    assert.deepEqual(
      securityDiagnostics(report).map(({ ruleId }) => ruleId),
      ["repository.security-baseline.tool-evidence-stale"],
    );
  });
});

test("rejects actionlint evidence when its opaque result artifact changes", async () => {
  await withConsumer({ includeTools: true }, async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, TOOL_CONFIGS.actionlint.resultPath),
      '{"tool":"actionlint","diagnostics":["changed-after-evidence"]}\n',
      "utf8",
    );
    const { result, report } = runCheck(consumerRoot);
    assert.equal(result.status, 1);
    assert.deepEqual(
      securityDiagnostics(report).map(({ ruleId }) => ruleId),
      ["repository.security-baseline.tool-evidence-result-digest-mismatch"],
    );
  });
});

test("reports advisory tool evidence without failing the capability", async () => {
  await withConsumer(
    { includeTools: true, actionlintRollout: "advisory" },
    async (consumerRoot) => {
      await unlink(join(consumerRoot, TOOL_CONFIGS.actionlint.evidencePath));
      const { result, report } = runCheck(consumerRoot);
      assert.equal(result.status, 0);
      assert.equal(report.outcome, "passed");
      assert.equal(report.summary.errors, 0);
      assert.equal(report.summary.warnings, 1);
      assert.equal(securityDiagnostics(report)[0].severity, "warning");
    },
  );
});
