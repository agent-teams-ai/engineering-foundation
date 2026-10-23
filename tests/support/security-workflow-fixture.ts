export const ACTION_SHA = "1111111111111111111111111111111111111111";
export const DEPENDENCY_REVIEW_SHA = "2222222222222222222222222222222222222222";
export const SBOM_SHA = "3333333333333333333333333333333333333333";
export const REUSABLE_WORKFLOW_SHA = "4444444444444444444444444444444444444444";
export const CONTAINER_DIGEST = "a".repeat(64);
export const JOB_CONTAINER_IMAGE = `ghcr.io/example/build@sha256:${CONTAINER_DIGEST}`;
export const SERVICE_CONTAINER_IMAGE = `ghcr.io/example/database@sha256:${"b".repeat(64)}`;
export const COMPOSITE_ACTION_SHA = "b".repeat(40);
export const TRANSITIVE_ACTION_SHA = "c".repeat(40);
export const ACTIONLINT_RUNNER_SHA = "d".repeat(40);
export const UNTRUSTED_SHA = "f".repeat(40);
export const UNUSED_SHA = "e".repeat(40);
export const ZIZMOR_RUNNER_SHA = "9".repeat(40);

interface WorkflowOptions {
  actionlintNonBlocking?: boolean;
  actionlintStepConditional?: boolean;
  actionlintStepNonBlocking?: boolean;
  dependencyReview?: boolean;
  extraStep?: string;
  installBeforeDependencyReview?: boolean;
  jobContainerImage?: string;
  pullRequest?: boolean;
  serviceContainerImage?: string;
}
export const TOOL_CONFIGS = {
  actionlint: {
    configPath: ".foundation/tool-config/actionlint.yaml",
    evidencePath: ".foundation/tool-evidence/actionlint.json",
    invocationUse: `example/actionlint-runner@${ACTIONLINT_RUNNER_SHA}`,
    jobId: "actionlint",
    resultPath: ".foundation/tool-results/actionlint.json",
    version: "1.7.7",
    workflowPath: ".github/workflows/ci.yml",
  },
  zizmor: {
    configPath: ".foundation/tool-config/zizmor.yaml",
    evidencePath: ".foundation/tool-evidence/zizmor.json",
    invocationUse: `example/zizmor-runner@${ZIZMOR_RUNNER_SHA}`,
    jobId: "zizmor",
    resultPath: ".foundation/tool-results/zizmor.json",
    version: "1.16.1",
    workflowPath: ".github/workflows/ci.yml",
  },
};

export function ciWorkflow({
  actionlintNonBlocking = false,
  actionlintStepConditional = false,
  actionlintStepNonBlocking = false,
  dependencyReview = true,
  extraStep = "",
  installBeforeDependencyReview = false,
  jobContainerImage,
  pullRequest = true,
  serviceContainerImage,
}: WorkflowOptions) {
  return [
    "name: CI",
    "on:",
    ...(pullRequest ? ["  pull_request:"] : ["  push:"]),
    "permissions:",
    "  contents: read",
    "jobs:",
    ...(dependencyReview
      ? [
          "  dependency-review:",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          `      - uses: actions/checkout@${ACTION_SHA}`,
          ...(installBeforeDependencyReview ? ["      - run: pnpm install --frozen-lockfile"] : []),
          `      - uses: actions/dependency-review-action@${DEPENDENCY_REVIEW_SHA}`,
          "        with:",
          "          base-ref: refs/heads/main",
          "          head-ref: refs/pull/current/head",
          "          fail-on-severity: moderate",
          "          vulnerability-check: true",
          "          warn-only: false",
        ]
      : []),
    "  check:",
    ...(dependencyReview ? ["    needs: dependency-review"] : []),
    "    runs-on: ubuntu-24.04",
    ...(jobContainerImage === undefined ? [] : [`    container: ${jobContainerImage}`]),
    ...(serviceContainerImage === undefined
      ? []
      : ["    services:", "      database:", `        image: ${serviceContainerImage}`]),
    "    steps:",
    `      - uses: actions/checkout@${ACTION_SHA}`,
    `      - uses: anchore/sbom-action@${SBOM_SHA}`,
    `      - uses: docker://ghcr.io/example/workflow-tool@sha256:${CONTAINER_DIGEST}`,
    "      - uses: ./.github/actions/checked-in-action",
    ...(extraStep === "" ? [] : [extraStep]),
    "  reusable:",
    ...(dependencyReview ? ["    needs: dependency-review"] : []),
    `    uses: example/reusable/.github/workflows/release.yml@${REUSABLE_WORKFLOW_SHA}`,
    "  actionlint:",
    "    runs-on: ubuntu-24.04",
    ...(actionlintNonBlocking ? ["    continue-on-error: true"] : []),
    "    steps:",
    ...(actionlintStepConditional ? ["      - if: always()"] : []),
    ...(actionlintStepConditional
      ? [
          `        uses: ${TOOL_CONFIGS.actionlint.invocationUse}`,
          ...(actionlintStepNonBlocking ? ["        continue-on-error: true"] : []),
        ]
      : [
          `      - uses: ${TOOL_CONFIGS.actionlint.invocationUse}`,
          ...(actionlintStepNonBlocking ? ["        continue-on-error: true"] : []),
        ]),
    "  zizmor:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    `      - uses: ${TOOL_CONFIGS.zizmor.invocationUse}`,
    "",
  ].join("\n");
}

export function compositeAction(use: string, run?: string) {
  return [
    "name: Checked-in action",
    "runs:",
    "  using: composite",
    "  steps:",
    `    - uses: ${use}`,
    ...(run === undefined ? [] : [`    - run: ${run}`]),
    "",
  ].join("\n");
}
