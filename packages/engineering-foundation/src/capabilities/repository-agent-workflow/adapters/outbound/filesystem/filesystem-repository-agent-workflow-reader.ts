import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { CapabilityInputError,assertNotCancelled } from "../../../../../features/validation-reporting/api.js";
import type {
  AgentInstructionPaths,
  InstructionFileEvidence,
  RepositoryAgentWorkflowEvidence,
  RepositoryAgentWorkflowPolicy
} from "../../../application/model/repository-agent-workflow.js";
import type { RepositoryAgentWorkflowReader } from "../../../application/ports/repository-agent-workflow-reader.js";

const MAX_INSTRUCTION_BYTES = 256 * 1024;
const PACKAGE_MANIFEST = "package.json";

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "repository-agent-workflow-evidence",
    retryable: false
  });
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
}

async function readInstruction(
  root: string,
  repositoryPath: string
): Promise<InstructionFileEvidence> {
  const candidate = resolve(root, repositoryPath);
  if (!contained(root, candidate)) {
    return { kind: "invalid" };
  }
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "invalid" };
  }
  if (metadata.isSymbolicLink()) {
    return { kind: "symlink" };
  }
  if (!metadata.isFile() || metadata.size > MAX_INSTRUCTION_BYTES) {
    return { kind: "invalid" };
  }
  const canonical = await realpath(candidate);
  if (!contained(root, canonical)) {
    return { kind: "invalid" };
  }
  return { kind: "file", source: await readFile(canonical, "utf8") };
}

async function readPackageScripts(root: string): Promise<Readonly<Record<string, string>>> {
  let input: unknown;
  try {
    input = JSON.parse(await readFile(resolve(root, PACKAGE_MANIFEST), "utf8")) as unknown;
  } catch {
    inputError("REPOSITORY_AGENT_WORKFLOW_PACKAGE_INVALID", "package.json must be valid JSON.");
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    inputError("REPOSITORY_AGENT_WORKFLOW_PACKAGE_INVALID", "package.json must be an object.");
  }
  const scriptsInput = (input as Record<string, unknown>)["scripts"];
  if (typeof scriptsInput !== "object" || scriptsInput === null || Array.isArray(scriptsInput)) {
    return Object.freeze({});
  }
  const scripts: Record<string, string> = {};
  for (const [name, command] of Object.entries(scriptsInput)) {
    if (typeof command === "string") {
      scripts[name] = command;
    }
  }
  return Object.freeze(scripts);
}

export class FilesystemRepositoryAgentWorkflowReader implements RepositoryAgentWorkflowReader {
  async read(
    consumerRoot: string,
    policy: RepositoryAgentWorkflowPolicy,
    signal?: AbortSignal
  ): Promise<RepositoryAgentWorkflowEvidence> {
    assertNotCancelled(signal);
    const root = await realpath(consumerRoot).catch(() =>
      inputError(
        "REPOSITORY_AGENT_WORKFLOW_ROOT_UNAVAILABLE",
        "The consumer root is unavailable."
      )
    );
    const entries = await Promise.all(
      (Object.entries(policy.instructions) as Array<[keyof AgentInstructionPaths, string]>).map(
        async ([kind, repositoryPath]) => [kind, await readInstruction(root, repositoryPath)] as const
      )
    );
    assertNotCancelled(signal);
    return Object.freeze({
      instructionFiles: Object.freeze(Object.fromEntries(entries)) as Readonly<
        Record<keyof AgentInstructionPaths, InstructionFileEvidence>
      >,
      packageScripts: await readPackageScripts(root)
    });
  }
}
