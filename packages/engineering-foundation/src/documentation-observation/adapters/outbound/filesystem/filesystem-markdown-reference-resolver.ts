import { extname, resolve } from "node:path";

import { assertNotCancelled } from "../../../../strict-yaml.js";
import type { MarkdownReferenceResolution } from "../../../application/model/markdown-document.js";
import type { ResolveMarkdownReferenceRequest } from "../../../application/ports/markdown-repository.js";
import { FilesystemMarkdownDocumentReader } from "./filesystem-markdown-document-reader.js";
import {
  isMissingMarkdownFilesystemError,
  markdownPathTraversesSymbolicLink,
  nodeFilesystemMarkdownOperations,
  throwMarkdownFilesystemUnavailable,
  type FilesystemMarkdownOperations
} from "./filesystem-markdown-filesystem.js";
import {
  createFilesystemMarkdownRepositoryContext,
  isWithinMarkdownRepository,
  markdownRepositoryPath,
  type FilesystemMarkdownRepositoryContext
} from "./filesystem-markdown-paths.js";
import {
  parseMarkdownReferenceTarget,
  stripMarkdownReferenceQuery,
  type MarkdownReferenceTarget
} from "./markdown-reference-target.js";

interface LocalReferenceCandidate {
  readonly absolutePath: string;
  readonly kind: "candidate";
}

interface LocatedReferenceTarget {
  readonly absolutePath: string;
  readonly kind: "located";
}

type CandidateResolution = LocalReferenceCandidate | MarkdownReferenceResolution;
type TargetLocation = LocatedReferenceTarget | MarkdownReferenceResolution;

async function hasExactFilesystemSpelling(
  absolutePath: string,
  filesystem: FilesystemMarkdownOperations,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const canonicalPath = await filesystem.realpath(absolutePath);
    assertNotCancelled(signal);
    return canonicalPath === absolutePath;
  } catch (error) {
    assertNotCancelled(signal);
    if (isMissingMarkdownFilesystemError(error)) {
      return false;
    }
    throwMarkdownFilesystemUnavailable(error, "checking Markdown reference path spelling");
  }
}

function terminalTargetResolution(
  target: MarkdownReferenceTarget
): MarkdownReferenceResolution | undefined {
  if (target.kind === "external") {
    return { kind: "external" };
  }
  if (target.kind === "unsafe") {
    return { kind: "unsafe", reason: target.reason };
  }
  return undefined;
}

async function resolveLocalCandidate(
  context: FilesystemMarkdownRepositoryContext,
  sourceRepositoryPath: string,
  target: string,
  filesystem: FilesystemMarkdownOperations,
  signal?: AbortSignal
): Promise<CandidateResolution> {
  assertNotCancelled(signal);
  const sourcePath = resolve(context.canonicalRoot, sourceRepositoryPath);
  const candidate = target.length === 0
    ? sourcePath
    : resolve(sourcePath, "..", stripMarkdownReferenceQuery(target));
  if (!isWithinMarkdownRepository(context.canonicalRoot, candidate)) {
    return { kind: "unsafe", reason: "repository-escape" };
  }
  if (
    await markdownPathTraversesSymbolicLink(
      context.canonicalRoot,
      candidate,
      filesystem,
      signal
    )
  ) {
    return { kind: "unsafe", reason: "symbolic-link" };
  }
  return { absolutePath: candidate, kind: "candidate" };
}

async function inspectFileTarget(
  context: FilesystemMarkdownRepositoryContext,
  absolutePath: string,
  missingReason: "directory-readme-missing" | "target-missing",
  filesystem: FilesystemMarkdownOperations,
  signal?: AbortSignal
): Promise<TargetLocation> {
  let metadata;
  try {
    metadata = await filesystem.lstat(absolutePath);
  } catch (error) {
    assertNotCancelled(signal);
    if (isMissingMarkdownFilesystemError(error)) {
      return {
        kind: "missing",
        reason: missingReason,
        repositoryPath: markdownRepositoryPath(context.canonicalRoot, absolutePath)
      };
    }
    throwMarkdownFilesystemUnavailable(error, "inspecting a Markdown reference target");
  }
  assertNotCancelled(signal);
  if (metadata.isSymbolicLink()) {
    return { kind: "unsafe", reason: "symbolic-link" };
  }
  if (!metadata.isFile()) {
    return {
      kind: "missing",
      reason: "target-missing",
      repositoryPath: markdownRepositoryPath(context.canonicalRoot, absolutePath)
    };
  }
  if (!(await hasExactFilesystemSpelling(absolutePath, filesystem, signal))) {
    return {
      kind: "missing",
      reason: missingReason,
      repositoryPath: markdownRepositoryPath(context.canonicalRoot, absolutePath)
    };
  }
  return { absolutePath, kind: "located" };
}

async function locateReferenceTarget(
  context: FilesystemMarkdownRepositoryContext,
  candidate: string,
  filesystem: FilesystemMarkdownOperations,
  signal?: AbortSignal
): Promise<TargetLocation> {
  let metadata;
  try {
    metadata = await filesystem.lstat(candidate);
  } catch (error) {
    assertNotCancelled(signal);
    if (isMissingMarkdownFilesystemError(error)) {
      return {
        kind: "missing",
        reason: "target-missing",
        repositoryPath: markdownRepositoryPath(context.canonicalRoot, candidate)
      };
    }
    throwMarkdownFilesystemUnavailable(error, "inspecting a Markdown reference target");
  }
  assertNotCancelled(signal);
  if (metadata.isSymbolicLink()) {
    return { kind: "unsafe", reason: "symbolic-link" };
  }
  if (!(await hasExactFilesystemSpelling(candidate, filesystem, signal))) {
    return {
      kind: "missing",
      reason: "target-missing",
      repositoryPath: markdownRepositoryPath(context.canonicalRoot, candidate)
    };
  }
  if (!metadata.isDirectory()) {
    return metadata.isFile()
      ? { absolutePath: candidate, kind: "located" }
      : {
          kind: "missing",
          reason: "target-missing",
          repositoryPath: markdownRepositoryPath(context.canonicalRoot, candidate)
        };
  }

  const readmePath = resolve(candidate, "README.md");
  if (
    await markdownPathTraversesSymbolicLink(
      context.canonicalRoot,
      readmePath,
      filesystem,
      signal
    )
  ) {
    return { kind: "unsafe", reason: "symbolic-link" };
  }
  return inspectFileTarget(
    context,
    readmePath,
    "directory-readme-missing",
    filesystem,
    signal
  );
}

async function resolveLocatedTarget(
  context: FilesystemMarkdownRepositoryContext,
  target: LocatedReferenceTarget,
  fragment: string,
  reader: FilesystemMarkdownDocumentReader,
  signal?: AbortSignal
): Promise<MarkdownReferenceResolution> {
  const repositoryPath = markdownRepositoryPath(context.canonicalRoot, target.absolutePath);
  if (extname(target.absolutePath).toLowerCase() !== ".md") {
    return { fragment, kind: "file", repositoryPath };
  }
  const document = await reader.read(context, target.absolutePath, signal);
  if (document === undefined) {
    return { kind: "missing", reason: "target-missing", repositoryPath };
  }
  return {
    fragment,
    kind: "file",
    markdownDocument: document,
    repositoryPath
  };
}

export async function resolveFilesystemMarkdownReference(
  request: ResolveMarkdownReferenceRequest,
  reader: FilesystemMarkdownDocumentReader,
  filesystem: FilesystemMarkdownOperations = nodeFilesystemMarkdownOperations
): Promise<MarkdownReferenceResolution> {
  assertNotCancelled(request.signal);
  const context = await createFilesystemMarkdownRepositoryContext(
    request.consumerRoot,
    filesystem,
    request.signal
  );
  assertNotCancelled(request.signal);
  const target = parseMarkdownReferenceTarget(request.rawTarget);
  const terminal = terminalTargetResolution(target);
  if (terminal !== undefined) {
    return terminal;
  }
  if (target.kind !== "local") {
    throw new Error("Markdown reference target classification is incomplete.");
  }

  const candidate = await resolveLocalCandidate(
    context,
    request.source.repositoryPath,
    target.target,
    filesystem,
    request.signal
  );
  if (candidate.kind !== "candidate") {
    return candidate;
  }
  const locatedTarget = await locateReferenceTarget(
    context,
    candidate.absolutePath,
    filesystem,
    request.signal
  );
  if (locatedTarget.kind !== "located") {
    return locatedTarget;
  }
  return resolveLocatedTarget(
    context,
    locatedTarget,
    target.fragment,
    reader,
    request.signal
  );
}
