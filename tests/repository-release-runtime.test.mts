import * as gitAuthorityCases from "./support/release-git-authority-cases.ts";
void gitAuthorityCases;
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  assertPnpmProfileQualificationRoot,
  assertPnpmProfileSourceIdentity,
} from "../tools/dev.mts";
import { projectNodeDependencyDeclarationsPolicy } from "../tools/runtime-policy.mts";
import { qualifyActualChangesetsRelease } from "./support/release-changesets-fixture.ts";
import { repositorySourceRoot } from "./support/repository-source.ts";

import {
  packagePhaseFixture,
  prepareProfileQualificationFixture,
} from "./support/repository-release-runtime-fixture.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  ".github/workflows/npm-package-bootstrap.yml",
  ".github/workflows/public-managed-registry-canary.yml",
] as const;
const pnpmSetupRevision = "pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b";

type WorkflowStep = {
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly name?: string;
  readonly env?: Record<string, unknown>;
  readonly run?: string;
  readonly "working-directory"?: unknown;
};
type WorkflowJob = { readonly if?: string; readonly steps?: WorkflowStep[] };
type Workflow = { readonly jobs?: Readonly<Record<string, WorkflowJob | undefined>> };
type BootstrapAdmission = {
  readonly enabled: boolean;
  readonly operation: "bootstrap" | "quarantine";
  readonly ref: string;
  readonly sourceSha: string;
  readonly expectedCommit: string;
};

function allSteps(workflow: Workflow): WorkflowStep[] {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job?.steps ?? []);
}

function bootstrapAdmission(
  job: "bootstrap" | "reconcile-github",
  admission: BootstrapAdmission,
): boolean {
  const admitted =
    admission.enabled &&
    admission.ref === "refs/heads/main" &&
    admission.sourceSha === admission.expectedCommit;
  return admitted && (job === "bootstrap" || admission.operation === "bootstrap");
}

void test("all four workflows provision every native pnpm setup at exact 11.20.0", async () => {
  let total = 0;
  for (const path of workflowPaths) {
    const workflow = parseYaml(await readFile(join(repositoryRoot, path), "utf8")) as Workflow;
    const setups = allSteps(workflow).filter(
      (step) => step.uses?.startsWith("pnpm/setup@") === true,
    );
    assert.ok(setups.length > 0, `${path} must retain its pinned native pnpm setup`);
    for (const setup of setups) {
      total += 1;
      assert.equal(setup.uses, pnpmSetupRevision);
      assert.ok(setup.with !== undefined);
      assert.equal(setup.with.version, "11.20.0");
      assert.equal(setup.with.install, false);
    }
  }
  assert.equal(total, 22);
});

void test("ordinary OIDC release does not install token interpolation before pnpm qualification", async () => {
  const workflow = parseYaml(
    await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8"),
  ) as Workflow;
  const setup = workflow.jobs?.["release"]?.steps?.find(
    (step) => step.uses?.startsWith("actions/setup-node@") === true,
  );
  assert.ok(setup);
  assert.equal(
    setup.with?.["registry-url"],
    undefined,
    "OIDC publishing must not install a token placeholder before strict pnpm qualification.",
  );
});

void test("bootstrap and reconciliation reject a source SHA mismatch before effects", async () => {
  const source = await readFile(
    join(repositoryRoot, ".github/workflows/npm-package-bootstrap.yml"),
    "utf8",
  );
  const workflow = parseYaml(source) as Workflow;
  const bootstrap = workflow.jobs?.["bootstrap"];
  const reconcile = workflow.jobs?.["reconcile-github"];
  assert.ok(bootstrap !== undefined);
  assert.ok(bootstrap.steps !== undefined);
  assert.ok(reconcile !== undefined);
  const bootstrapIf =
    "${{ vars.NPM_PACKAGE_BOOTSTRAP_ENABLED == \x27true\x27 && github.ref == \x27refs/heads/main\x27 && github.sha == inputs.expected_commit }}";
  const reconcileIf =
    "${{ vars.NPM_PACKAGE_BOOTSTRAP_ENABLED == \x27true\x27 && inputs.operation == \x27bootstrap\x27 && github.ref == \x27refs/heads/main\x27 && github.sha == inputs.expected_commit }}";
  assert.equal(bootstrap.if, bootstrapIf);
  assert.equal(reconcile.if, reconcileIf);
  const checkout = bootstrap.steps.find(
    (step) => step.uses?.startsWith("actions/checkout@") === true,
  );
  assert.equal(checkout?.with?.ref, "${{ inputs.expected_commit }}");
  const sourceAuthority = bootstrap.steps.find(
    (step) => "name" in step && step.name === "Bind explicit source Git authority",
  );
  assert.ok(sourceAuthority);
  assert.match(String(sourceAuthority.run), /GIT_DIR=.*GIT_WORK_TREE=.*GIT_CEILING_DIRECTORIES=/su);
  const profileInstall = bootstrap.steps.find(
    (step) =>
      "name" in step && step.name === "Install the clean Node/pnpm package-operation projection",
  );
  assert.equal(
    profileInstall?.env?.["AGENT_TEAMS_FOUNDATION_SOURCE_SHA"],
    "${{ inputs.expected_commit }}",
  );
  for (const step of bootstrap.steps) {
    const profileRoot = step["working-directory"];
    if (typeof profileRoot !== "string" && profileRoot !== undefined) {
      throw new Error("Bootstrap working-directory must be a string.");
    }
    if (profileRoot?.includes(".worker-tmp/profiles/node-") === true) {
      assert.equal(profileRoot, ".worker-tmp/profiles/node-${{ inputs.expected_commit }}");
    }
  }
  assert.match(source, /test "\$\(git rev-parse HEAD\)" = "\$\{EXPECTED_COMMIT\}"/u);
  assert.match(source, /test "\$\(git rev-parse origin\/main\)" = "\$\{EXPECTED_COMMIT\}"/u);
  assert.doesNotMatch(source, /profiles\/node-\$\{\{ github\.sha \}\}/u);

  const expectedCommit = "a".repeat(40);
  const matching: BootstrapAdmission = {
    enabled: true,
    operation: "bootstrap",
    ref: "refs/heads/main",
    sourceSha: expectedCommit,
    expectedCommit,
  };
  assert.equal(bootstrapAdmission("bootstrap", matching), true);
  assert.equal(bootstrapAdmission("reconcile-github", matching), true);
  assert.equal(bootstrapAdmission("bootstrap", { ...matching, operation: "quarantine" }), true);
  assert.equal(
    bootstrapAdmission("reconcile-github", { ...matching, operation: "quarantine" }),
    false,
  );
  for (const mismatch of [
    { enabled: false },
    { ref: "refs/heads/feature/test" },
    { sourceSha: "b".repeat(40) },
  ] as const) {
    const admission = { ...matching, ...mismatch };
    assert.equal(bootstrapAdmission("bootstrap", admission), false);
    assert.equal(bootstrapAdmission("reconcile-github", admission), false);
  }
});

void test("public canary keeps builder Node 26 separate from selected public cohort Node", async () => {
  const source = await readFile(
    join(repositoryRoot, ".github/workflows/public-managed-registry-canary.yml"),
    "utf8",
  );
  const builderNode = source.indexOf('node-version: "26.11.1"');
  const profileInstall = source.indexOf("node tools/dev.mts --profile node install");
  const profileBuild = source.indexOf("node tools/dev.mts --profile node build");
  const selectedNode = source.indexOf(
    "node-version: ${{ steps.select-cohort-runtime.outputs.node }}",
  );
  const selectedCapture = source.indexOf("PUBLIC_CANARY_NODE_EXECUTABLE=");
  const canaryRun = source.indexOf(
    '"${PUBLIC_CANARY_NODE_EXECUTABLE}" scripts/public-managed-registry-canary.mjs',
  );
  assert.ok(builderNode >= 0 && profileInstall > builderNode && profileBuild > profileInstall);
  assert.ok(
    selectedNode > profileBuild && selectedCapture > selectedNode && canaryRun > selectedCapture,
  );
  assert.doesNotMatch(source, /(?:bun|node) scripts\/public-managed-registry-canary\.mjs/u);
  assert.doesNotMatch(source, /cache: pnpm/u);
  assert.doesNotMatch(source, /npm\s+(?:publish|unpublish|deprecate|dist-tag)|pnpm\s+publish/u);
});

void test("Node profile qualification requires a real virtual store outside lock refresh", async () => {
  const actualSourceRoot = await repositorySourceRoot();
  await mkdir(join(repositoryRoot, ".worker-tmp"), { recursive: true });
  const temporary = await mkdtemp(join(repositoryRoot, ".worker-tmp/profile-qualification-"));
  const sourceRoot = join(temporary, "source");
  const profileRoot = join(temporary, "profile");
  try {
    const { manifest, policy, dependencyPath, dependencies, projectedDependencies, evidence } =
      await prepareProfileQualificationFixture(actualSourceRoot, sourceRoot, profileRoot);
    await assert.rejects(
      assertPnpmProfileQualificationRoot(profileRoot, sourceRoot),
      /actual pnpm virtual store/u,
    );
    await assertPnpmProfileQualificationRoot(profileRoot, sourceRoot, false);
    await mkdir(join(profileRoot, "node_modules/.pnpm"), { recursive: true });
    await writeFile(join(profileRoot, "node_modules/.pnpm/lock.yaml"), "lockfileVersion: '9.0'\n");
    await assertPnpmProfileQualificationRoot(profileRoot, sourceRoot);
    await assertPnpmProfileSourceIdentity(profileRoot, sourceRoot);
    await writeFile(join(profileRoot, "injected.ts"), "export const invalid = true;\n");
    await assert.rejects(
      assertPnpmProfileSourceIdentity(profileRoot, sourceRoot),
      /source projection digest evidence is stale/u,
    );
    await rm(join(profileRoot, "injected.ts"));
    const workspaceBytes = await readFile(join(profileRoot, "pnpm-workspace.yaml"));
    await rm(join(profileRoot, "pnpm-workspace.yaml"));
    await assert.rejects(
      assertPnpmProfileSourceIdentity(profileRoot, sourceRoot),
      /source projection digest evidence is stale/u,
    );
    await writeFile(join(profileRoot, "pnpm-workspace.yaml"), workspaceBytes);
    await writeFile(
      join(profileRoot, "architecture/foundation/repository-runtime.json"),
      `${policy}\n`,
    );
    await assert.rejects(
      assertPnpmProfileSourceIdentity(profileRoot, sourceRoot),
      /source projection digest evidence is stale/u,
    );
    await writeFile(join(profileRoot, "architecture/foundation/repository-runtime.json"), policy);
    const { createWorkspaceDependencyDeclarationsCapability } =
      await import("../packages/engineering-foundation/dist/capabilities/workspace-dependency-declarations/module.js");
    const { createWorkspaceInventoryReader } =
      await import("../packages/engineering-foundation/dist/workspace-inventory/module.js");
    const { readFoundationSchema } =
      await import("../packages/engineering-foundation/dist/schema-catalog.js");
    const capability = createWorkspaceDependencyDeclarationsCapability(
      createWorkspaceInventoryReader(),
      readFoundationSchema,
    );
    for (const consumerRoot of [sourceRoot, profileRoot]) {
      assert.equal(
        (await capability.run({ consumerRoot, configPath: dependencyPath })).outcome,
        "passed",
      );
    }
    await writeFile(join(profileRoot, dependencyPath), dependencies);
    assert.deepEqual(
      (
        await capability.run({ consumerRoot: profileRoot, configPath: dependencyPath })
      ).diagnostics.map(({ ruleId }) => ruleId),
      ["workspace.dependency-declarations.package-manager-not-exact"],
    );
    // Profile custody binds both policy bytes independently of the broad source digest.
    const evidencePath = join(profileRoot, ".agent-teams-runtime-profile.json");
    for (const value of [
      dependencies,
      projectedDependencies.replace(
        "externalDependencies: catalog",
        "externalDependencies: direct",
      ),
    ]) {
      await writeFile(join(profileRoot, dependencyPath), value);
      await assert.rejects(
        assertPnpmProfileQualificationRoot(profileRoot, sourceRoot, false),
        /dependency declaration policy projection or digest evidence is stale/u,
      );
    }
    await writeFile(join(profileRoot, dependencyPath), projectedDependencies);
    await writeFile(
      join(sourceRoot, dependencyPath),
      dependencies.replace('"@agent-teams/"', '"@other/"'),
    );
    await assert.rejects(
      assertPnpmProfileQualificationRoot(profileRoot, sourceRoot, false),
      /dependency declaration policy projection or digest evidence is stale/u,
    );
    await writeFile(join(sourceRoot, dependencyPath), dependencies);
    for (const key of [
      "originalDependencyDeclarationsPolicySha256",
      "derivedDependencyDeclarationsPolicySha256",
    ] as const) {
      await writeFile(evidencePath, JSON.stringify({ ...evidence, [key]: "0".repeat(64) }));
      await assert.rejects(
        assertPnpmProfileQualificationRoot(profileRoot, sourceRoot, false),
        /dependency declaration policy projection or digest evidence is stale/u,
      );
    }
    for (const missing of [
      ["originalDependencyDeclarationsPolicySha256"],
      ["derivedDependencyDeclarationsPolicySha256"],
      ["originalDependencyDeclarationsPolicySha256", "derivedDependencyDeclarationsPolicySha256"],
    ]) {
      const historicalEvidence = { ...evidence };
      for (const key of missing) {
        Reflect.deleteProperty(historicalEvidence, key);
      }
      await writeFile(evidencePath, JSON.stringify(historicalEvidence));
      await assert.rejects(
        assertPnpmProfileQualificationRoot(profileRoot, sourceRoot, false),
        /qualification evidence is malformed/u,
      );
    }
    await writeFile(evidencePath, JSON.stringify(evidence));
    await assertPnpmProfileQualificationRoot(profileRoot, sourceRoot);
    await writeFile(join(sourceRoot, "source-marker"), "stale source evidence must fail\n");
    await assert.rejects(
      assertPnpmProfileQualificationRoot(profileRoot, sourceRoot, false),
      /source digest evidence is stale/u,
    );
    await rm(join(sourceRoot, "source-marker"));
    assert.equal(await readFile(join(sourceRoot, dependencyPath), "utf8"), dependencies);
    await writeFile(join(profileRoot, "package.json"), manifest);
    await assert.rejects(
      assertPnpmProfileQualificationRoot(profileRoot, sourceRoot),
      /exact private pnpm profile projection/u,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const releaseHelper = await readFile(join(repositoryRoot, "tools/release-profile.mts"), "utf8");
  const devHelper = await readFile(join(repositoryRoot, "tools/dev.mts"), "utf8");
  assert.match(devHelper, /requireVirtualStore: boolean = true/u);
  assert.equal(
    (releaseHelper.match(/assertPnpmProfileQualificationRoot\([^;]+false\)/gu) ?? []).length,
    1,
  );
  assert.match(
    releaseHelper,
    /async function refreshVersionLocks[\s\S]*assertPnpmProfileQualificationRoot\([^;]+false\)/u,
  );
});

async function actualChangesetsVersioningTest(context: TestContext): Promise<void> {
  if (process.env["AGENT_TEAMS_FOUNDATION_RUN_CHANGESETS_TEST"] !== "1") {
    context.skip("set AGENT_TEAMS_FOUNDATION_RUN_CHANGESETS_TEST=1 for the finite external TEST");
    return;
  }
  const bunCandidate = process.env["AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE"] ?? "bun";
  const bunVersion = spawnSync(bunCandidate, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (
    bunVersion.error !== undefined ||
    bunVersion.status !== 0 ||
    bunVersion.stdout.trim() !== "1.4.3"
  ) {
    context.skip("admitted Bun 1.4.3 is unavailable");
    return;
  }
  await qualifyActualChangesetsRelease(bunCandidate, context);
}

void test(
  "actual pinned Changesets TEST versioning passes final release file admission",
  actualChangesetsVersioningTest,
);

void test("Node dependency policy projection changes one manager line and rejects unsupported source shapes", async () => {
  const source = await readFile(
    join(await repositorySourceRoot(), "architecture/foundation/dependency-declarations.yaml"),
    "utf8",
  );
  for (const newline of ["\n", "\r\n"]) {
    const original = source.replaceAll("\r\n", "\n").replaceAll("\n", newline);
    assert.equal(
      projectNodeDependencyDeclarationsPolicy(original),
      original.replace("  kind: bun", "  kind: pnpm"),
    );
  }
  for (const invalid of [
    source.replace("schemaVersion: 2", "schemaVersion: 1"),
    source.replace("schemaVersion: 2", "schemaVersion: 3"),
    `${source}schemaVersion: 2\n`,
    `${source}"schemaVersion": 2\n`,
    source.replace("  kind: bun", "  kind: pnpm"),
    source.replace("  kind: bun", "  kind: bun\n  kind: bun"),
    source.replace("workspaceManifest: pnpm-workspace.yaml", "workspaceManifest: package.json"),
    `${source}packageManager:\n  kind: bun\n  workspaceManifest: pnpm-workspace.yaml\n`,
    source.replace("  kind: bun", "  extra: true\n  kind: bun"),
    `${source}"\\u0073chemaVersion": 2\n`,
    `${source}"\\u0070ackageManager": {kind: bun, workspaceManifest: pnpm-workspace.yaml}\n`,
    `${source}? schemaVersion\n: 2\n`,
    `${source}unknown: [unterminated\n`,
    `${source}---\npolicies: {}\n`,
    source.replace("policies:", "policies: &authority"),
    source.replace("policies:", "policies: {"),
    `${source}trailing scalar\n`,
    `${source}unknown: value\n`,
    `${source}# invalid comment\u0000\n`,
    source.slice(0, source.indexOf("policies:")) +
      "policies: {externalDependencies: catalog, catalogVersions: exact, internalDependencies: workspace-protocol, reservedScopes: [], developmentOnlyPackages: [], exactRegistryDevelopmentOnlyPackages: []}\n",
    source.replace("    - knip", "    - [knip"),
    source.replace("    - knip", "    - *tool"),
    source.replace("    - knip", "    - knip\n    - knip"),
  ]) {
    assert.throws(
      () => projectNodeDependencyDeclarationsPolicy(invalid),
      /exact repository v2 Bun dependency declaration policy/u,
    );
  }
});

void test("Bun package phase requires an owned current installed Node projection before compiler effects", async (t) => {
  // Synthetic compiler/store sentinels prove dispatch/refusal only; actual package qualification uses a real install.
  const fixture = await packagePhaseFixture(repositoryRoot);
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const invoke = (env: NodeJS.ProcessEnv = {}) =>
    spawnSync(
      fixture.node,
      [join(fixture.sourceRoot, "tools/repository-command.mts"), "script", "package:check:built"],
      {
        cwd: fixture.sourceRoot,
        env: { ...fixture.environment, ...env },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
  const reject = async (env: NodeJS.ProcessEnv, expected: RegExp) => {
    const result = invoke(env);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, expected);
    await assert.rejects(readFile(fixture.compilerMarker), { code: "ENOENT" });
    await assert.rejects(readFile(fixture.observation), { code: "ENOENT" });
  };
  await reject({ AGENT_TEAMS_FOUNDATION_SOURCE_ROOT: fixture.parent }, /source claims differ/u);
  await reject({ AGENT_TEAMS_FOUNDATION_SOURCE_SHA: "0".repeat(40) }, /source claims differ/u);
  await reject({ AGENT_TEAMS_FOUNDATION_PROFILE_ROOT: fixture.parent }, /one dedicated child/u);
  await reject(
    {
      AGENT_TEAMS_FOUNDATION_PROFILE_ROOT: join(fixture.sourceRoot, ".worker-tmp/profiles/missing"),
    },
    /ENOENT/u,
  );
  const marker = join(fixture.targetRoot, ".agent-teams-runtime-profile.json");
  const evidenceBytes = await readFile(marker, "utf8");
  const evidence = JSON.parse(evidenceBytes) as Record<string, unknown>;
  await writeFile(marker, JSON.stringify({ ...evidence, sourceSha: "0".repeat(40) }));
  await reject({}, /source commit evidence is stale/u);
  await writeFile(marker, evidenceBytes);
  const projected = join(fixture.targetRoot, "observe.cjs");
  const script = await readFile(projected, "utf8");
  await writeFile(projected, script + "\n// tampered source\n");
  await reject({}, /source projection digest evidence is stale/u);
  await writeFile(projected, script);
  const store = join(fixture.targetRoot, "node_modules/.pnpm/lock.yaml");
  await rm(store);
  await reject({}, /actual pnpm virtual store/u);
  await writeFile(store, "lockfileVersion: '9.0'\n");
  const accepted = invoke({
    AGENT_TEAMS_FOUNDATION_SOURCE_ROOT: undefined,
    AGENT_TEAMS_FOUNDATION_SOURCE_SHA: undefined,
  });
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.equal(await readFile(fixture.compilerMarker, "utf8"), "compiler");
  assert.deepEqual(JSON.parse(await readFile(fixture.observation, "utf8")), {
    cwd: fixture.targetRoot,
    node: fixture.nodeVersion,
    profile: "node",
  });
  await rm(fixture.observation);
  const direct = spawnSync(
    fixture.node,
    [join(fixture.targetRoot, "tools/repository-command.mts"), "script", "package:check:built"],
    {
      cwd: fixture.targetRoot,
      env: { ...fixture.environment, AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "node" },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(direct.status, 0, direct.stdout + direct.stderr);
  const directObservation = JSON.parse(await readFile(fixture.observation, "utf8")) as {
    readonly cwd: string;
  };
  assert.equal(directObservation.cwd, fixture.targetRoot);
});
