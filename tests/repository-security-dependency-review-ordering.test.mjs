import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repositoryRoot, "packages", "engineering-foundation", "dist", "cli.js");
const CHECKOUT_SHA = "1111111111111111111111111111111111111111";
const DEPENDENCY_REVIEW_SHA = "2222222222222222222222222222222222222222";
const SBOM_SHA = "3333333333333333333333333333333333333333";
const EXTERNAL_REUSABLE_WORKFLOW_SHA = "4444444444444444444444444444444444444444";
const EXTERNAL_REUSABLE_WORKFLOW =
  `example/reusable/.github/workflows/verify.yml@${EXTERNAL_REUSABLE_WORKFLOW_SHA}`;

function dependencyReviewConfig(additionalAllowedUses = []) {
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
    "allowedContainerImages: []",
    "allowedUses:",
    `  - uses: actions/checkout@${CHECKOUT_SHA}`,
    "    transitiveUses: []",
    `  - uses: actions/dependency-review-action@${DEPENDENCY_REVIEW_SHA}`,
    "    transitiveUses: []",
    `  - uses: anchore/sbom-action@${SBOM_SHA}`,
    "    transitiveUses: []",
    ...additionalAllowedUses.flatMap((uses) => [`  - uses: ${uses}`, "    transitiveUses: []"]),
    "privilegedJobs: []",
    "publishablePackageManifests:",
    "  - packages/library/package.json",
    "",
  ].join("\n");
}

function ciWorkflow(preReviewStep = "") {
  return [
    "name: CI",
    "on:",
    "  pull_request:",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  dependency-review:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    `      - uses: actions/checkout@${CHECKOUT_SHA}`,
    ...(preReviewStep === "" ? [] : [preReviewStep]),
    `      - uses: actions/dependency-review-action@${DEPENDENCY_REVIEW_SHA}`,
    "        with:",
    "          base-ref: refs/heads/main",
    "          head-ref: refs/pull/current/head",
    "          fail-on-severity: moderate",
    "          vulnerability-check: true",
    "          warn-only: false",
    "  check:",
    "    needs: dependency-review",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    `      - uses: actions/checkout@${CHECKOUT_SHA}`,
    "      - run: node scripts/build.mjs",
    `      - uses: anchore/sbom-action@${SBOM_SHA}`,
    "",
  ].join("\n");
}

function secondWorkflow(trigger) {
  return [
    "name: Secondary",
    "on:",
    `  ${trigger}:`,
    "permissions:",
    "  contents: read",
    "jobs:",
    "  execute:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    `      - uses: actions/checkout@${CHECKOUT_SHA}`,
    "      - run: pnpm install --frozen-lockfile",
    "",
  ].join("\n");
}

function reusableWorkflow(trigger) {
  return [
    "name: Secondary",
    "on:",
    `  ${trigger}:`,
    "permissions:",
    "  contents: read",
    "jobs:",
    "  execute:",
    `    uses: ${EXTERNAL_REUSABLE_WORKFLOW}`,
    "",
  ].join("\n");
}

function locallyProtectedWorkflow() {
  return [
    "name: Protected secondary",
    "on:",
    "  pull_request:",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  dependency-review:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    `      - uses: actions/checkout@${CHECKOUT_SHA}`,
    `      - uses: actions/dependency-review-action@${DEPENDENCY_REVIEW_SHA}`,
    "        with:",
    "          base-ref: refs/heads/main",
    "          head-ref: refs/pull/current/head",
    "          fail-on-severity: moderate",
    "          vulnerability-check: true",
    "          warn-only: false",
    "  execute:",
    "    needs: dependency-review",
    "    if: github.event.pull_request.user.type != 'Bot'",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      - run: node scripts/build.mjs",
    "",
  ].join("\n");
}

async function writeRepositoryFile(root, path, source) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source, "utf8");
}

async function withConsumer(options, callback) {
  const root = await mkdtemp(join(tmpdir(), "foundation-dependency-review-ordering-"));
  try {
    const files = {
      "foundation.config.yaml": [
        "schemaVersion: 1",
        "project:",
        "  id: dependency-review-ordering",
        "capabilities:",
        "  repository.security-baseline:",
        "    configPath: architecture/foundation/repository-security-baseline.yaml",
        "",
      ].join("\n"),
      "architecture/foundation/repository-security-baseline.yaml": dependencyReviewConfig(
        options.additionalAllowedUses,
      ),
      ".github/actions/checked-in-action/action.yml": [
        "name: Checked-in action",
        "runs:",
        "  using: composite",
        "  steps:",
        "    - run: echo checked-in-action",
        "",
      ].join("\n"),
      ".github/workflows/ci.yml": ciWorkflow(options.preReviewStep),
      "packages/library/package.json": `${JSON.stringify(
        {
          name: "@fixture/library",
          version: "1.0.0",
          files: ["dist"],
          publishConfig: { provenance: true },
        },
        null,
        2,
      )}\n`,
      ...options.additionalWorkflows,
    };
    for (const [path, source] of Object.entries(files)) {
      await writeRepositoryFile(root, path, source);
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

function orderingDiagnostic(report) {
  return report.capabilities[0].diagnostics.find(
    ({ ruleId }) => ruleId === "repository.security-baseline.dependency-review-ordering",
  );
}

test("allows repository code after a non-conditional Dependency Review prerequisite", async () => {
  await withConsumer({}, async (consumerRoot) => {
    const { result, report } = runCheck(consumerRoot);
    assert.equal(result.status, 0);
    assert.equal(report.outcome, "passed");
  });
});

test("allows a secondary pull-request workflow with its own equivalent review gate", async () => {
  await withConsumer(
    {
      additionalWorkflows: {
        ".github/workflows/protected-secondary.yml": locallyProtectedWorkflow(),
      },
    },
    async (consumerRoot) => {
      const { result, report } = runCheck(consumerRoot);
      assert.equal(result.status, 0, JSON.stringify(report));
      assert.equal(report.outcome, "passed");
    },
  );
});

test("rejects every pull-request route that can execute before review", async (t) => {
  const cases = [
    {
      name: "second pull-request workflow",
      options: {
        additionalWorkflows: { ".github/workflows/secondary.yml": secondWorkflow("pull_request") },
      },
      path: ".github/workflows/secondary.yml",
      execution: "run-step",
    },
    {
      name: "pull-request-target workflow",
      options: {
        additionalWorkflows: { ".github/workflows/secondary.yml": secondWorkflow("pull_request_target") },
      },
      path: ".github/workflows/secondary.yml",
      execution: "run-step",
    },
    {
      name: "local composite action",
      options: { preReviewStep: "      - uses: ./.github/actions/checked-in-action" },
      path: ".github/workflows/ci.yml",
      execution: "local-action",
    },
    {
      name: "Node script wrapper",
      options: { preReviewStep: "      - run: node scripts/install-deps.mjs" },
      path: ".github/workflows/ci.yml",
      execution: "run-step",
    },
    {
      name: "eval shell wrapper",
      options: { preReviewStep: "      - run: eval 'pnpm install --frozen-lockfile'" },
      path: ".github/workflows/ci.yml",
      execution: "run-step",
    },
    {
      name: "conditional shell wrapper",
      options: { preReviewStep: "      - run: if pnpm install --frozen-lockfile; then :; fi" },
      path: ".github/workflows/ci.yml",
      execution: "run-step",
    },
    {
      name: "external reusable workflow",
      options: {
        additionalAllowedUses: [EXTERNAL_REUSABLE_WORKFLOW],
        additionalWorkflows: {
          ".github/workflows/secondary.yml": reusableWorkflow("pull_request"),
        },
      },
      path: ".github/workflows/secondary.yml",
      execution: "reusable-workflow",
    },
  ];
  for (const current of cases) {
    await t.test(current.name, async () => {
      await withConsumer(current.options, async (consumerRoot) => {
        const { result, report } = runCheck(consumerRoot);
        assert.equal(result.status, 1);
        const diagnostic = orderingDiagnostic(report);
        assert.equal(diagnostic?.location.path, current.path);
        assert.deepEqual(diagnostic?.evidence.slice(0, 2), [
          { kind: "dependency-review-job", value: "dependency-review" },
          { kind: "repository-code-execution", value: current.execution },
        ]);
      });
    });
  }
});
