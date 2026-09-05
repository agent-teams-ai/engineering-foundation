import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  Sha256Digest
} from "../../application/model/scaffold-values.js";
import { sha256Json } from "../../kernel/canonical-json.js";
import { ScaffoldError } from "../../scaffold-error.js";
import { pathTraversesSymbolicLink } from "../../../filesystem-path-safety.js";
import {
  assertRepositoryRelativePath,
  parseStrictYamlSource
} from "../../../strict-yaml.js";
import {
  readContainedRepositoryFile,
  type LoadedRepositoryFile
} from "./node-repository-file.js";
import { ScaffoldAuthorityStaleError } from "./node-authority-error.js";

const MAX_AUTHORITY_DOCUMENTS = 4096;
const MAX_AUTHORITY_DOCUMENT_ENTRIES = 16_384;
const MAX_AUTHORITY_DOCUMENT_DEPTH = 32;
const MAX_AUTHORITY_METADATA_LENGTH = 160;
const OWNER_DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const OWNER_DOCUMENT_STATUS_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/u;

interface OwnerDocumentMetadata {
  readonly id: string;
  readonly status: string;
}

interface AuthorityDocumentTraversalBudget {
  entriesVisited: number;
  documentsVisited: number;
}

export interface ResolvedOwnerDocument extends OwnerDocumentMetadata {
  readonly file: LoadedRepositoryFile;
  readonly indexDigest: Sha256Digest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) &&
      relation !== ".." &&
      !isAbsolute(relation))
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseOwnerFrontmatter(source: string): OwnerDocumentMetadata {
  const normalized = source.replace(/\r\n?/gu, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "Authority documents must start with strict YAML frontmatter."
    );
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "Authority document YAML frontmatter must have a closing delimiter."
    );
  }
  const parsed = parseStrictYamlSource(
    normalized.slice(4, end),
    "scaffold-owner-document"
  );
  if (
    !isRecord(parsed) ||
    typeof parsed.id !== "string" ||
    typeof parsed.status !== "string" ||
    parsed.id.length > MAX_AUTHORITY_METADATA_LENGTH ||
    parsed.status.length > MAX_AUTHORITY_METADATA_LENGTH ||
    !OWNER_DOCUMENT_ID_PATTERN.test(parsed.id) ||
    !OWNER_DOCUMENT_STATUS_PATTERN.test(parsed.status)
  ) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "Authority document frontmatter must contain normalized id and status strings."
    );
  }
  return Object.freeze({ id: parsed.id, status: parsed.status });
}

async function listMarkdownFilesInRoot(options: {
  readonly canonicalConsumerRoot: string;
  readonly documentRoot: string;
  readonly budget: AuthorityDocumentTraversalBudget;
}): Promise<readonly string[]> {
  assertRepositoryRelativePath(
    options.documentRoot,
    "scaffold-owner-document-root"
  );
  const absoluteRoot = resolve(
    options.canonicalConsumerRoot,
    options.documentRoot
  );
  if (
    (await pathTraversesSymbolicLink(
      options.canonicalConsumerRoot,
      absoluteRoot
    )) ||
    !isContained(options.canonicalConsumerRoot, await realpath(absoluteRoot)) ||
    !(await lstat(absoluteRoot)).isDirectory()
  ) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      `Authority document root must be a contained regular directory: ${options.documentRoot}.`
    );
  }

  const paths: string[] = [];
  const walk = async (
    absoluteDirectory: string,
    repositoryDirectory: string,
    depth: number
  ): Promise<void> => {
    if (depth > MAX_AUTHORITY_DOCUMENT_DEPTH) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Authority document roots cannot exceed ${MAX_AUTHORITY_DOCUMENT_DEPTH} directory levels.`
      );
    }
    const entries = [];
    const directory = await opendir(absoluteDirectory);
    for await (const entry of directory) {
      options.budget.entriesVisited += 1;
      if (options.budget.entriesVisited > MAX_AUTHORITY_DOCUMENT_ENTRIES) {
        throw new ScaffoldError(
          "SCAFFOLD_INPUT_INVALID",
          `Authority document roots cannot contain more than ${MAX_AUTHORITY_DOCUMENT_ENTRIES} entries.`
        );
      }
      entries.push(entry);
    }
    entries.sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      const repositoryPath = `${repositoryDirectory}/${entry.name}`;
      const absolutePath = resolve(absoluteDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new ScaffoldError(
          "SCAFFOLD_INPUT_INVALID",
          `Authority document roots cannot contain symbolic links: ${repositoryPath}.`
        );
      }
      if (entry.isDirectory()) {
        await walk(absolutePath, repositoryPath, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        options.budget.documentsVisited += 1;
        if (options.budget.documentsVisited > MAX_AUTHORITY_DOCUMENTS) {
          throw new ScaffoldError(
            "SCAFFOLD_INPUT_INVALID",
            `Authority document roots cannot contain more than ${MAX_AUTHORITY_DOCUMENTS} Markdown files.`
          );
        }
        paths.push(repositoryPath);
      } else if (!entry.isFile()) {
        throw new ScaffoldError(
          "SCAFFOLD_INPUT_INVALID",
          `Authority document roots may contain only regular files and directories: ${repositoryPath}.`
        );
      }
    }
  };
  await walk(absoluteRoot, options.documentRoot, 0);
  return Object.freeze(paths);
}

async function listAuthorityDocumentPaths(
  consumerRoot: string,
  documentRoots: readonly string[]
): Promise<readonly string[]> {
  try {
    const normalizedRoots = documentRoots
      .map((documentRoot) => documentRoot.toLowerCase())
      .toSorted(compareStrings);
    for (const [index, root] of normalizedRoots.entries()) {
      for (const candidate of normalizedRoots.slice(index + 1)) {
        if (
          root === candidate ||
          root.startsWith(`${candidate}/`) ||
          candidate.startsWith(`${root}/`)
        ) {
          throw new ScaffoldError(
            "SCAFFOLD_INPUT_INVALID",
            "Authority document roots cannot overlap or differ only by case."
          );
        }
      }
    }
    const canonicalConsumerRoot = await realpath(consumerRoot);
    const budget = { entriesVisited: 0, documentsVisited: 0 };
    const paths: string[] = [];
    for (const documentRoot of documentRoots.toSorted(compareStrings)) {
      paths.push(
        ...(await listMarkdownFilesInRoot({
          canonicalConsumerRoot,
          documentRoot,
          budget
        }))
      );
    }
    paths.sort(compareStrings);
    const exact = new Set(paths);
    const caseFolded = new Set(paths.map((path) => path.toLowerCase()));
    if (exact.size !== paths.length || caseFolded.size !== paths.length) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        "Authority document roots overlap or contain case-folding path collisions."
      );
    }
    return Object.freeze(paths);
  } catch (error) {
    if (error instanceof ScaffoldError) {
      throw error;
    }
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "Cannot index configured authority document roots.",
      [],
      { cause: error }
    );
  }
}

export async function resolveOwnerDocument(options: {
  readonly consumerRoot: string;
  readonly documentRoots: readonly string[];
  readonly ownerDocumentId: string;
}): Promise<ResolvedOwnerDocument> {
  if (!OWNER_DOCUMENT_ID_PATTERN.test(options.ownerDocumentId)) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "Owner document ID must be a normalized authority identifier."
    );
  }
  const paths = await listAuthorityDocumentPaths(
    options.consumerRoot,
    options.documentRoots
  );
  const index: {
    readonly path: string;
    readonly id: string;
    readonly status: string;
  }[] = [];
  const matches: {
    readonly file: LoadedRepositoryFile;
    readonly metadata: OwnerDocumentMetadata;
  }[] = [];
  for (const path of paths) {
    const file = await readContainedRepositoryFile(
      options.consumerRoot,
      path,
      "scaffold-owner-document"
    );
    const metadata = parseOwnerFrontmatter(file.source);
    index.push({ path: file.path, id: metadata.id, status: metadata.status });
    if (metadata.id === options.ownerDocumentId) {
      matches.push({ file, metadata });
    }
  }
  if (matches.length !== 1) {
    throw new ScaffoldAuthorityStaleError(
      `Owner document must resolve exactly once from configured roots: ${options.ownerDocumentId}.`
    );
  }
  const selected = matches[0] as (typeof matches)[number];
  const indexDigest = sha256Json(index);
  return Object.freeze({
    ...selected.metadata,
    file: selected.file,
    indexDigest
  });
}
