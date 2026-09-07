import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import type {
  AgentInstructionPaths,
  AgentWorkflowScripts,
  ChangedCheckPolicy,
  RepositoryAgentWorkflowPolicy
} from "../../../application/model/repository-agent-workflow.js";

import { configurationInputError as inputError, assertConfigRepositoryRelativePath } from "../../../application/configuration-input.js";

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") {
    inputError(`${field} must be a string.`);
  }
  return value;
}

function path(value: unknown, field: string): string {
  const result = string(value, field);
  assertConfigRepositoryRelativePath(result);
  return result;
}

function paths(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    inputError(`${field} must be an array.`);
  }
  return Object.freeze(value.map((entry, index) => path(entry, `${field}[${index}]`)));
}

function instructions(value: unknown): AgentInstructionPaths {
  const input = record(value, "instructions");
  return Object.freeze({
    canonical: path(input["canonical"], "instructions.canonical"),
    claude: path(input["claude"], "instructions.claude"),
    gemini: path(input["gemini"], "instructions.gemini"),
    copilot: path(input["copilot"], "instructions.copilot")
  });
}

function scripts(value: unknown): AgentWorkflowScripts {
  const input = record(value, "scripts");
  return Object.freeze({
    changed: string(input["changed"], "scripts.changed"),
    fast: string(input["fast"], "scripts.fast"),
    full: string(input["full"], "scripts.full")
  });
}

function changedCheck(value: unknown, index: number): ChangedCheckPolicy {
  const field = `changedChecks[${index}]`;
  const input = record(value, field);
  const extensionsInput = input["extensions"];
  if (!Array.isArray(extensionsInput)) {
    inputError(`${field}.extensions must be an array.`);
  }
  return Object.freeze({
    id: string(input["id"], `${field}.id`),
    script: string(input["script"], `${field}.script`),
    extensions: Object.freeze(
      extensionsInput.map((entry, extensionIndex) =>
        string(entry, `${field}.extensions[${extensionIndex}]`).toLowerCase()
      )
    ),
    passPaths: input["passPaths"] !== false
  });
}

export function parseAgentWorkflowPolicy(input: unknown, configPath: string): RepositoryAgentWorkflowPolicy {
  const root = record(input, "repository agent workflow config");
  const checksInput = root["changedChecks"];
  if (!Array.isArray(checksInput)) {
    inputError("changedChecks must be an array.");
  }
  const result = Object.freeze({
    instructions: instructions(root["instructions"]),
    scripts: scripts(root["scripts"]),
    changedChecks: Object.freeze(checksInput.map(changedCheck)),
    fullScanPaths: paths(root["fullScanPaths"], "fullScanPaths")
  });
  const instructionPaths: readonly string[] = [
    result.instructions.canonical,
    result.instructions.claude,
    result.instructions.gemini,
    result.instructions.copilot
  ];
  if (new Set(instructionPaths).size !== instructionPaths.length) {
    inputError("Instruction file paths must be unique.");
  }
  const scriptNames = result.changedChecks.map(({ script }) => script);
  const checkIds = result.changedChecks.map(({ id }) => id);
  if (new Set(scriptNames).size !== scriptNames.length) {
    inputError("changedChecks scripts must be unique.");
  }
  if (new Set(checkIds).size !== checkIds.length) {
    inputError("changedChecks ids must be unique.");
  }
  for (const check of result.changedChecks) {
    if (new Set(check.extensions).size !== check.extensions.length) {
      inputError(`changedChecks.${check.id} extensions must be unique ignoring case.`);
    }
  }
  if (scriptNames.includes(result.scripts.changed)) {
    inputError("The changed workflow script cannot invoke itself.");
  }
  if (result.scripts.fast === result.scripts.changed) {
    inputError("The fast workflow script cannot be the changed workflow script.");
  }
  return Object.freeze({
    ...result,
    fullScanPaths: Object.freeze(
      [...new Set<string>([
        ...result.fullScanPaths,
        ...instructionPaths,
        "foundation.config.yaml",
        configPath,
        "package.json"
      ])].toSorted(compareBinaryStrings)
    )
  });
}
