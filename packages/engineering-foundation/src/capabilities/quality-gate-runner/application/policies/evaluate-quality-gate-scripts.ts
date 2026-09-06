import type { FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";
import type {
  PackageScriptCatalog,
  QualityGatePolicy
} from "../model/quality-gate.js";

const PACKAGE_SCRIPT_REFERENCE =
  /(?:^|[;&|()]|\s)(?:pnpm|npm)\s+(?:run(?:-script)?\s+)?([A-Za-z0-9][A-Za-z0-9:._-]*)/gu;

function scriptReferences(command: string): readonly string[] {
  const references: string[] = [];
  for (const match of command.matchAll(PACKAGE_SCRIPT_REFERENCE)) {
    const script = match[1];
    if (script !== undefined) {
      references.push(script);
    }
  }
  return Object.freeze(references);
}

function reachesRunner(
  scriptId: string,
  catalog: PackageScriptCatalog,
  visiting = new Set<string>()
): boolean {
  if (visiting.has(scriptId)) {
    return false;
  }
  const command = catalog.scripts[scriptId];
  if (command === undefined) {
    return false;
  }
  if (
    (command.includes("agent-teams-foundation") ||
      command.includes("engineering-foundation/dist/cli.js")) &&
    (command.includes("gate run") || command.includes("gate\trun"))
  ) {
    return true;
  }
  const next = new Set(visiting);
  next.add(scriptId);
  return scriptReferences(command).some((reference) =>
    reachesRunner(reference, catalog, next)
  );
}

function diagnostic(input: {
  readonly ruleId: "quality.gate-runner.script-missing" | "quality.gate-runner.script-recursive";
  readonly scriptId: string;
  readonly message: string;
}): FoundationDiagnostic {
  return Object.freeze({
    ruleId: input.ruleId,
    severity: "error",
    subject: input.scriptId,
    message: input.message,
    location: { path: "package.json" },
    relatedLocations: [],
    evidence: [{ kind: "script-id", value: input.scriptId }],
    remediation: input.ruleId.endsWith("missing")
      ? "Add the package script or remove it from every quality gate profile."
      : "Remove the direct or indirect quality gate runner invocation from this script.",
    requiresArchitectureReview: false
  });
}

export function evaluateQualityGateScripts(
  policy: QualityGatePolicy,
  catalog: PackageScriptCatalog
): readonly FoundationDiagnostic[] {
  const scriptIds = [...new Set(
    policy.profiles.flatMap(({ tasks }) => tasks.map(({ id }) => id))
  )].toSorted();
  return Object.freeze(scriptIds.flatMap((scriptId) => {
    if (catalog.scripts[scriptId] === undefined) {
      return [diagnostic({
        ruleId: "quality.gate-runner.script-missing",
        scriptId,
        message: `Quality gate task ${scriptId} is not an existing root package.json script.`
      })];
    }
    if (reachesRunner(scriptId, catalog)) {
      return [diagnostic({
        ruleId: "quality.gate-runner.script-recursive",
        scriptId,
        message: `Quality gate task ${scriptId} directly or indirectly invokes the gate runner.`
      })];
    }
    return [];
  }));
}
