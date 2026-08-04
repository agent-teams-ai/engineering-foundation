import { open, mkdir, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { CapabilityInputError } from "../../../../../../capability-runtime.js";
import {
  ContainedFileReadError,
  pathTraversesSymbolicLink,
  readContainedRegularFile
} from "../../../../../../filesystem-path-safety.js";
import type {
  BufQualificationArtifacts,
  BufQualificationEvidenceWriteResult
} from "../../../ports/buf-qualification-artifacts.js";

const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "protobuf-buf-qualification-artifacts",
    retryable: false
  });
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
  );
}

function readFailure(error: ContainedFileReadError, path: string, optional: boolean): never | undefined {
  if (optional && error.failure === "missing") {
    return undefined;
  }
  inputError(
    error.failure === "symlink" || error.failure === "escape"
      ? "BUF_QUALIFICATION_PATH_UNSAFE"
      : "BUF_QUALIFICATION_INPUT_UNAVAILABLE",
    `Qualification artifact is unavailable, unsafe, or changed while reading: ${path}.`
  );
}

async function readContained(input: {
  readonly consumerRoot: string;
  readonly path: string;
  readonly maxBytes: number;
  readonly optional: boolean;
}): Promise<Buffer | undefined> {
  try {
    return await readContainedRegularFile({
      candidate: resolve(input.consumerRoot, input.path),
      maxBytes: input.maxBytes,
      root: input.consumerRoot
    });
  } catch (error) {
    if (!(error instanceof ContainedFileReadError)) {
      throw error;
    }
    readFailure(error, input.path, input.optional);
    return undefined;
  }
}

async function canonicalWriteTarget(consumerRoot: string, path: string): Promise<string> {
  const root = await realpath(consumerRoot);
  const candidate = resolve(root, path);
  if (!contained(root, candidate)) {
    inputError("BUF_QUALIFICATION_PATH_UNSAFE", "Evidence path escapes the consumer repository.");
  }
  const parent = dirname(candidate);
  await mkdir(parent, { recursive: true });
  if (await pathTraversesSymbolicLink(root, parent)) {
    inputError("BUF_QUALIFICATION_PATH_UNSAFE", "Evidence directory cannot traverse a symbolic link.");
  }
  const canonicalParent = await realpath(parent);
  if (!contained(root, canonicalParent)) {
    inputError("BUF_QUALIFICATION_PATH_UNSAFE", "Evidence directory escapes the consumer repository.");
  }
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile() || (await pathTraversesSymbolicLink(root, candidate))) {
      inputError("BUF_QUALIFICATION_PATH_UNSAFE", "Evidence target must be a regular non-symlink file.");
    }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;
    if (code !== "ENOENT") {
      throw error;
    }
  }
  return candidate;
}

async function writeAtomic(path: string, source: string): Promise<void> {
  const temporaryRoot = await mkdtemp(join(dirname(path), ".buf-evidence-"));
  const temporaryPath = join(temporaryRoot, "evidence.json");
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(source, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

export class FilesystemBufQualificationArtifacts implements BufQualificationArtifacts {
  async readInput(input: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly maxBytes: number;
    readonly label: string;
  }): Promise<Uint8Array> {
    const bytes = await readContained({ ...input, optional: false });
    if (bytes === undefined) {
      inputError("BUF_QUALIFICATION_INPUT_UNAVAILABLE", `${input.label} is unavailable.`);
    }
    return bytes;
  }

  async readExistingEvidence(input: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly maxBytes: number;
  }): Promise<string | undefined> {
    const bytes = await readContained({ ...input, optional: true });
    return bytes?.toString("utf8");
  }

  async writeEvidence(input: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly source: string;
  }): Promise<BufQualificationEvidenceWriteResult> {
    const existing = await this.readExistingEvidence({
      consumerRoot: input.consumerRoot,
      path: input.path,
      maxBytes: MAX_EVIDENCE_BYTES
    });
    if (existing === input.source) {
      return "unchanged";
    }
    const target = await canonicalWriteTarget(input.consumerRoot, input.path);
    await writeAtomic(target, input.source);
    return existing === undefined ? "created" : "updated";
  }
}
