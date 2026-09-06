import { createUniqueRegistry } from "../../../features/validation-reporting/api.js";

const DOCUMENTATION =
  "https://github.com/agent-teams-ai/engineering-foundation/blob/main/docs/reference/quality-gate-runner.md";

const rules = [
  {
    id: "quality.gate-runner.script-missing",
    rationale: "Every declared gate task must resolve to an existing root package script.",
    remediation: "Add the package.json script or remove the task from the profile.",
    documentation: DOCUMENTATION
  },
  {
    id: "quality.gate-runner.script-recursive",
    rationale: "A gate task must not directly or indirectly invoke the gate runner.",
    remediation: "Remove the runner invocation from the package script call chain.",
    documentation: DOCUMENTATION
  }
] as const;

export const QUALITY_GATE_RUNNER_RULES_BY_ID = createUniqueRegistry(
  "rule",
  rules.map((rule) => [rule.id, rule])
);
