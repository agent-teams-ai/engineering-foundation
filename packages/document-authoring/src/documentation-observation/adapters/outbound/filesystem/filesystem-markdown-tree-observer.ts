import { extname, resolve } from "node:path";

import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import { CapabilityInputError } from "../../../application/model/input-problem.js";
import { assertNotCancelled } from "../../../application/policies/cancellation.js";
import type {
  MarkdownDocumentObservation,
  MarkdownObservationIssue,
  MarkdownRepositoryObservation
} from "../../../application/model/markdown-document.js";
import type { ObserveMarkdownRepositoryRequest } from "../../../application/ports/markdown-repository.js";
import {
  FilesystemMarkdownDocumentReader,
  MarkdownSourceInvalidError,
  MAX_MARKDOWN_BYTES
} from "./filesystem-markdown-document-reader.js";
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

const SKIPPED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);
const MAX_MARKDOWN_DOCUMENTS = 10_000;
const MAX_MARKDOWN_ISSUES = 10_000;
const MAX_MARKDOWN_REFERENCES = 100_000;
const MAX_MARKDOWN_TOTAL_BYTES = 32 * 1024 * 1024;

interface MarkdownTreeObservationCollector {
  documentBytes: number;
  documentReferences: number;
  estimatedDocumentBytes: number;
  readonly documents: Map<string, MarkdownDocumentObservation>;
  readonly issues: MarkdownObservationIssue[];
}

function resourceLimit(message: string): never {
  throw new CapabilityInputError({
    code: "DOCUMENTATION_RESOURCE_LIMIT_EXCEEDED",
    message,
    phase: "documentation-observation",
    retryable: false
  });
}

interface MarkdownTreeWalkContext {
  readonly collector: MarkdownTreeObservationCollector;
  readonly excludedPrefixes: readonly string[];
  readonly filesystem: FilesystemMarkdownOperations;
  readonly reader: FilesystemMarkdownDocumentReader;
  readonly repository: FilesystemMarkdownRepositoryContext;
  readonly signal?: AbortSignal;
}

function matchesRepositoryPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isExcludedPath(walk: MarkdownTreeWalkContext, path: string): boolean {
  return walk.excludedPrefixes.some((prefix) =>
    matchesRepositoryPrefix(path, prefix)
  );
}

function addIssue(
  collector: MarkdownTreeObservationCollector,
  issue: MarkdownObservationIssue
): void {
  if (collector.issues.length >= MAX_MARKDOWN_ISSUES) {
    resourceLimit(`Markdown observation exceeds ${MAX_MARKDOWN_ISSUES} issues.`);
  }
  collector.issues.push(issue);
}

async function walkConfiguredRoot(
  walk: MarkdownTreeWalkContext,
  root: string
): Promise<void> {
  const { collector, filesystem, repository: context, signal } = walk;
  const absoluteRoot = resolve(context.canonicalRoot, root);
  if (isExcludedPath(walk, root)) {
    return;
  }
  if (!isWithinMarkdownRepository(context.canonicalRoot, absoluteRoot)) {
    addIssue(collector, {
      kind: "symbolic-link",
      message: "Configured Markdown root escapes the consumer repository.",
      repositoryPath: root
    });
    return;
  }
  if (
    await markdownPathTraversesSymbolicLink(
      context.canonicalRoot,
      absoluteRoot,
      filesystem,
      signal
    )
  ) {
    addIssue(collector, {
      kind: "symbolic-link",
      message: "Configured Markdown root traverses a symbolic link.",
      repositoryPath: root
    });
    return;
  }

  let metadata;
  try {
    metadata = await filesystem.lstat(absoluteRoot);
  } catch (error) {
    assertNotCancelled(signal);
    if (isMissingMarkdownFilesystemError(error)) {
      addIssue(collector, {
        kind: "root-missing",
        message: "Configured Markdown root does not exist.",
        repositoryPath: root
      });
      return;
    }
    throwMarkdownFilesystemUnavailable(error, "inspecting a configured Markdown root");
  }
  assertNotCancelled(signal);
  if (metadata.isSymbolicLink()) {
    addIssue(collector, {
      kind: "symbolic-link",
      message: "Configured Markdown root must not be a symbolic link.",
      repositoryPath: root
    });
    return;
  }
  if (!metadata.isDirectory()) {
    addIssue(collector, {
      kind: "root-not-directory",
      message: "Configured Markdown root must be a directory.",
      repositoryPath: root
    });
    return;
  }
  await walkDirectory(walk, absoluteRoot, root);
}

async function inspectDirectoryEntry(
  walk: MarkdownTreeWalkContext,
  candidate: string
): Promise<void> {
  const { collector, filesystem, reader, repository: context, signal } = walk;
  const candidateRepositoryPath = markdownRepositoryPath(context.canonicalRoot, candidate);
  if (isExcludedPath(walk, candidateRepositoryPath)) {
    return;
  }
  if (collector.documents.has(candidateRepositoryPath)) {
    return;
  }
  let metadata;
  try {
    metadata = await filesystem.lstat(candidate);
  } catch (error) {
    assertNotCancelled(signal);
    if (isMissingMarkdownFilesystemError(error)) {
      return;
    }
    throwMarkdownFilesystemUnavailable(error, "inspecting a Markdown source entry");
  }
  assertNotCancelled(signal);
  if (metadata.isSymbolicLink()) {
    addIssue(collector, {
      kind: "symbolic-link",
      message: "Markdown source tree must not contain symbolic links.",
      repositoryPath: candidateRepositoryPath
    });
    return;
  }
  if (metadata.isDirectory()) {
    await walkDirectory(walk, candidate);
    return;
  }
  if (!metadata.isFile() || extname(candidate).toLowerCase() !== ".md") {
    return;
  }
  if (metadata.size > MAX_MARKDOWN_BYTES) {
    addIssue(collector, {
      kind: "source-too-large",
      message: `Markdown source exceeds ${MAX_MARKDOWN_BYTES} bytes.`,
      repositoryPath: candidateRepositoryPath
    });
    return;
  }
  const estimatedDocumentBytes = collector.estimatedDocumentBytes + metadata.size;
  if (
    collector.documents.size >= MAX_MARKDOWN_DOCUMENTS ||
    estimatedDocumentBytes > MAX_MARKDOWN_TOTAL_BYTES
  ) {
    resourceLimit(
      `Markdown observation exceeds ${MAX_MARKDOWN_DOCUMENTS} documents or ${MAX_MARKDOWN_TOTAL_BYTES} bytes.`
    );
  }

  let document;
  try {
    document = await reader.read(context, candidate, signal);
  } catch (error) {
    if (error instanceof MarkdownSourceInvalidError) {
      addIssue(collector, {
        kind: "source-invalid",
        message: error.message,
        repositoryPath: candidateRepositoryPath
      });
      return;
    }
    throw error;
  }
  if (document === undefined) {
    try {
      await filesystem.lstat(candidate);
    } catch (error) {
      assertNotCancelled(signal);
      if (isMissingMarkdownFilesystemError(error)) {
        return;
      }
      throwMarkdownFilesystemUnavailable(error, "rechecking a Markdown source entry");
    }
    assertNotCancelled(signal);
    addIssue(collector, {
      kind: "source-unreadable",
      message: "Markdown source could not be read.",
      repositoryPath: candidateRepositoryPath
    });
    return;
  }
  const nextDocumentBytes =
    collector.documentBytes + Buffer.byteLength(document.source, "utf8");
  if (nextDocumentBytes > MAX_MARKDOWN_TOTAL_BYTES) {
    resourceLimit(
      `Markdown observation exceeds ${MAX_MARKDOWN_TOTAL_BYTES} bytes after contained reads.`
    );
  }
  const nextReferenceCount =
    collector.documentReferences + document.references.length;
  if (nextReferenceCount > MAX_MARKDOWN_REFERENCES) {
    resourceLimit(
      `Markdown observation exceeds ${MAX_MARKDOWN_REFERENCES} references.`
    );
  }
  collector.documentBytes = nextDocumentBytes;
  collector.documentReferences = nextReferenceCount;
  collector.estimatedDocumentBytes = estimatedDocumentBytes;
  collector.documents.set(document.repositoryPath, document);
}

async function walkDirectory(
  walk: MarkdownTreeWalkContext,
  directory: string,
  configuredRoot?: string
): Promise<void> {
  const { collector, filesystem, signal } = walk;
  assertNotCancelled(signal);
  if (
    await markdownPathTraversesSymbolicLink(
      walk.repository.canonicalRoot,
      directory,
      filesystem,
      signal
    )
  ) {
    addIssue(collector, {
      kind: "symbolic-link",
      message: "Markdown source directory became a symbolic link during observation.",
      repositoryPath: markdownRepositoryPath(
        walk.repository.canonicalRoot,
        directory
      )
    });
    return;
  }
  let entries;
  try {
    entries = await filesystem.readdir(directory, { withFileTypes: true });
  } catch (error) {
    assertNotCancelled(signal);
    if (isMissingMarkdownFilesystemError(error)) {
      if (configuredRoot !== undefined) {
        addIssue(collector, {
          kind: "root-missing",
          message: "Configured Markdown root does not exist.",
          repositoryPath: configuredRoot
        });
      }
      return;
    }
    throwMarkdownFilesystemUnavailable(error, "reading a Markdown source directory");
  }
  assertNotCancelled(signal);
  if (
    await markdownPathTraversesSymbolicLink(
      walk.repository.canonicalRoot,
      directory,
      filesystem,
      signal
    )
  ) {
    addIssue(collector, {
      kind: "symbolic-link",
      message: "Markdown source directory changed during observation.",
      repositoryPath: markdownRepositoryPath(
        walk.repository.canonicalRoot,
        directory
      )
    });
    return;
  }
  for (const entry of entries.toSorted((left, right) =>
    compareBinaryStrings(left.name, right.name)
  )) {
    assertNotCancelled(signal);
    if (!SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
      await inspectDirectoryEntry(
        walk,
        resolve(directory, entry.name)
      );
    }
  }
}

export async function observeFilesystemMarkdownTree(
  request: ObserveMarkdownRepositoryRequest,
  reader: FilesystemMarkdownDocumentReader,
  filesystem: FilesystemMarkdownOperations = nodeFilesystemMarkdownOperations
): Promise<MarkdownRepositoryObservation> {
  assertNotCancelled(request.signal);
  reader.reset();
  const context = await createFilesystemMarkdownRepositoryContext(
    request.consumerRoot,
    filesystem,
    request.signal
  );
  assertNotCancelled(request.signal);
  const collector: MarkdownTreeObservationCollector = {
    documentBytes: 0,
    documentReferences: 0,
    estimatedDocumentBytes: 0,
    documents: new Map(),
    issues: []
  };
  const walk: MarkdownTreeWalkContext = {
    collector,
    excludedPrefixes: (request.excludedPrefixes ?? []).toSorted(compareBinaryStrings),
    filesystem,
    reader,
    repository: context,
    ...(request.signal === undefined ? {} : { signal: request.signal })
  };

  for (const root of request.roots.toSorted()) {
    await walkConfiguredRoot(walk, root);
  }

  return {
    documents: [...collector.documents.values()].toSorted((left, right) =>
      compareBinaryStrings(left.repositoryPath, right.repositoryPath)
    ),
    issues: collector.issues.toSorted((left, right) =>
      compareBinaryStrings(left.repositoryPath, right.repositoryPath) ||
      compareBinaryStrings(left.kind, right.kind)
    )
  };
}
