import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep, win32 } from "node:path";

import { CapabilityInputError } from "../../../../../capability-runtime.js";
import {
  ContainedFileReadError,
  inspectContainedRegularFile,
  readContainedRegularFile
} from "../../../../../filesystem-path-safety.js";
import {
  assertNotCancelled,
  assertRepositoryRelativePath
} from "../../../../../strict-yaml.js";
import type {
  EffectiveInstructionCandidateObservation,
  EffectiveInstructionDirectoryObservation,
  EffectiveInstructionDiscovery
} from "../../../application/model/effective-instructions.js";
import { EFFECTIVE_INSTRUCTION_CANDIDATE_NAMES } from "../../../application/model/effective-instructions.js";
import type { EffectiveInstructionsReader } from "../../../application/ports/effective-instructions-reader.js";

const MAXIMUM_INSTRUCTION_SOURCE_BYTES = 256 * 1024;

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "repository-agent-workflow-effective-instructions",
    retryable: false
  });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
}

function hasUnsafeDisplayCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      codePoint === 0x061c ||
      (codePoint >= 0x200e && codePoint <= 0x200f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

async function resolveConsumerRoot(consumerRoot: string): Promise<string> {
  try {
    const root = await realpath(consumerRoot);
    if (!(await stat(root)).isDirectory()) {
      inputError(
        "REPOSITORY_AGENT_WORKFLOW_ROOT_INVALID",
        "The consumer root must be an existing directory."
      );
    }
    return root;
  } catch (error) {
    if (error instanceof CapabilityInputError) {
      throw error;
    }
    inputError(
      "REPOSITORY_AGENT_WORKFLOW_ROOT_UNAVAILABLE",
      "The consumer root is unavailable."
    );
  }
}

async function safeTargetDirectories(
  root: string,
  targetDirectory: string
): Promise<readonly { readonly absolute: string; readonly repositoryPath: string }[]> {
  const directories = [{ absolute: root, repositoryPath: "." }];
  let absolute = root;
  let repositoryPath = "";
  const segments = targetDirectory === "." ? [] : targetDirectory.split("/");
  for (const segment of segments) {
    const next = join(absolute, segment);
    let metadata;
    try {
      metadata = await lstat(next);
    } catch (error) {
      if (isMissing(error)) {
        inputError(
          "REPOSITORY_AGENT_WORKFLOW_TARGET_DIRECTORY_MISSING",
          `The target directory does not exist: ${targetDirectory}.`
        );
      }
      inputError(
        "REPOSITORY_AGENT_WORKFLOW_TARGET_DIRECTORY_UNAVAILABLE",
        `The target directory is unavailable: ${targetDirectory}.`
      );
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      inputError(
        "REPOSITORY_AGENT_WORKFLOW_TARGET_DIRECTORY_INVALID",
        `The target path must have only real repository directories: ${targetDirectory}.`
      );
    }
    const canonical = await realpath(next).catch(() =>
      inputError(
        "REPOSITORY_AGENT_WORKFLOW_TARGET_DIRECTORY_UNAVAILABLE",
        `The target directory is unavailable: ${targetDirectory}.`
      )
    );
    if (!contained(root, canonical)) {
      inputError(
        "REPOSITORY_AGENT_WORKFLOW_TARGET_DIRECTORY_ESCAPE",
        `The target directory escapes the consumer repository: ${targetDirectory}.`
      );
    }
    absolute = canonical;
    repositoryPath = repositoryPath.length === 0
      ? segment
      : posix.join(repositoryPath, segment);
    directories.push({ absolute, repositoryPath });
  }
  return Object.freeze(directories);
}

async function readCandidate(
  root: string,
  directory: { readonly absolute: string; readonly repositoryPath: string },
  name: string,
  mode: "classify" | "content" | "metadata"
): Promise<EffectiveInstructionCandidateObservation> {
  const repositoryPath = directory.repositoryPath === "."
    ? name
    : posix.join(directory.repositoryPath, name);
  const candidate = join(directory.absolute, name);
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if (isMissing(error)) {
      return Object.freeze({ kind: "missing", path: repositoryPath });
    }
    inputError(
      "REPOSITORY_AGENT_WORKFLOW_INSTRUCTION_UNAVAILABLE",
      `The instruction candidate is unavailable: ${repositoryPath}.`
    );
  }
  if (metadata.isSymbolicLink()) {
    return Object.freeze({ kind: "symlink", path: repositoryPath });
  }
  if (!metadata.isFile()) {
    return Object.freeze({ kind: "not-file", path: repositoryPath });
  }
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) {
    inputError(
      "REPOSITORY_AGENT_WORKFLOW_INSTRUCTION_UNAVAILABLE",
      `The instruction candidate has an unsupported size: ${repositoryPath}.`
    );
  }
  if (mode === "classify") {
    return Object.freeze({
      kind: "file",
      path: repositoryPath,
      sourceBytes: metadata.size,
      bytes: null
    });
  }
  if (mode === "metadata") {
    try {
      const observation = await inspectContainedRegularFile({ candidate, root });
      return Object.freeze({
        kind: "file",
        path: repositoryPath,
        sourceBytes: observation.size,
        bytes: null
      });
    } catch (error) {
      const detail = error instanceof ContainedFileReadError ? error.failure : "unavailable";
      inputError(
        "REPOSITORY_AGENT_WORKFLOW_INSTRUCTION_UNAVAILABLE",
        `The instruction candidate must remain a stable real repository file: ${repositoryPath} (${detail}).`
      );
    }
  }
  try {
    const bytes = await readContainedRegularFile({
      candidate,
      maxBytes: MAXIMUM_INSTRUCTION_SOURCE_BYTES,
      root
    });
    return Object.freeze({
      kind: "file",
      path: repositoryPath,
      sourceBytes: bytes.byteLength,
      bytes
    });
  } catch (error) {
    const detail = error instanceof ContainedFileReadError ? error.failure : "unavailable";
    inputError(
      "REPOSITORY_AGENT_WORKFLOW_INSTRUCTION_UNAVAILABLE",
      `The instruction candidate must be a stable real file no larger than ${MAXIMUM_INSTRUCTION_SOURCE_BYTES} bytes: ${repositoryPath} (${detail}).`
    );
  }
}

export class FilesystemEffectiveInstructionsReader implements EffectiveInstructionsReader {
  async discover(input: {
    readonly consumerRoot: string;
    readonly targetPath: string;
    readonly signal?: AbortSignal;
  }): Promise<EffectiveInstructionDiscovery> {
    assertNotCancelled(input.signal);
    if (
      hasUnsafeDisplayCharacter(input.targetPath) ||
      win32.isAbsolute(input.targetPath) ||
      input.targetPath.normalize("NFC") !== input.targetPath
    ) {
      inputError(
        "REPOSITORY_AGENT_WORKFLOW_TARGET_PATH_INVALID",
        "The target path must be a well-formed repository-relative POSIX path in Unicode NFC without control, bidirectional-formatting, or line-separator characters."
      );
    }
    assertRepositoryRelativePath(
      input.targetPath,
      "repository-agent-workflow-effective-instructions"
    );
    const root = await resolveConsumerRoot(input.consumerRoot);
    const targetDirectory = posix.dirname(input.targetPath);
    const directories = await safeTargetDirectories(root, targetDirectory);
    const target = join(root, ...input.targetPath.split("/"));
    const targetMetadata = await lstat(target).catch((error: unknown) => {
      if (isMissing(error)) {
        return null;
      }
      inputError(
        "REPOSITORY_AGENT_WORKFLOW_TARGET_UNAVAILABLE",
        `The target path is unavailable: ${input.targetPath}.`
      );
    });
    if (targetMetadata !== null &&
      (targetMetadata.isSymbolicLink() || !targetMetadata.isFile())) {
      inputError(
        "REPOSITORY_AGENT_WORKFLOW_TARGET_INVALID",
        `The target must be a repository file or a planned file path: ${input.targetPath}.`
      );
    }
    assertNotCancelled(input.signal);
    return Object.freeze({
      targetPath: input.targetPath,
      targetDirectory,
      directories: Object.freeze(directories.map(({ repositoryPath }) => repositoryPath))
    });
  }

  async readDirectory(input: {
    readonly consumerRoot: string;
    readonly directory: string;
    readonly readSelectedBytes: boolean;
    readonly signal?: AbortSignal;
  }): Promise<EffectiveInstructionDirectoryObservation> {
    assertNotCancelled(input.signal);
    if (input.directory !== ".") {
      assertRepositoryRelativePath(
        input.directory,
        "repository-agent-workflow-effective-instructions"
      );
    }
    const root = await resolveConsumerRoot(input.consumerRoot);
    const directories = await safeTargetDirectories(root, input.directory);
    const directory = directories.at(-1);
    if (directory === undefined || directory.repositoryPath !== input.directory) {
      inputError(
        "REPOSITORY_AGENT_WORKFLOW_TARGET_DIRECTORY_INVALID",
        `The instruction directory is invalid: ${input.directory}.`
      );
    }
    const candidates: EffectiveInstructionCandidateObservation[] = [];
    let selected = false;
    for (const name of EFFECTIVE_INSTRUCTION_CANDIDATE_NAMES) {
      const mode = selected
        ? "classify"
        : input.readSelectedBytes ? "content" : "metadata";
      const candidate = await readCandidate(
        root,
        directory,
        name,
        mode
      );
      candidates.push(candidate);
      selected ||= candidate.kind === "file" || candidate.kind === "symlink";
    }
    assertNotCancelled(input.signal);
    return Object.freeze({
      directory: input.directory,
      candidates: Object.freeze(candidates)
    });
  }
}
