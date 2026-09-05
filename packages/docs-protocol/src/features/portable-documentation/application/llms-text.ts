import type { DocsFindDocument } from "./model.js";
import { CommunityContextError, rankCommunityDocuments } from "./ranked-search.js";

const DEFAULT_MAXIMUM_DOCUMENTS = 64;
const DEFAULT_MAXIMUM_BYTES = 262_144;
export const MINIMUM_COMMUNITY_CONTEXT_BYTES = 1_024;
export const MAXIMUM_COMMUNITY_CONTEXT_BYTES = 1_048_576;
export const MAXIMUM_COMMUNITY_CONTEXT_DOCUMENTS = 10_000;

const BINARY = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

export interface CommunityContextCatalog {
  readonly projectId: string;
  readonly title: string;
  readonly summary?: string;
}

export interface CommunityContextLimits {
  readonly maxDocuments?: number;
  readonly maxBytes?: number;
}

export interface EffectiveCommunityContextLimits {
  readonly maxDocuments: number;
  readonly maxBytes: number;
}

export interface CommunityLlmsTextInput {
  readonly catalog: CommunityContextCatalog;
  readonly documents: readonly DocsFindDocument[];
  readonly limits?: CommunityContextLimits;
  readonly selection?:
    | { readonly kind: "filtered" }
    | { readonly kind: "fuzzy-advisory" };
}

export interface CommunityLlmsTextProjection {
  readonly content: string;
  readonly includedDocuments: number;
  readonly omittedDocuments: number;
  readonly truncated: boolean;
  readonly limits: EffectiveCommunityContextLimits;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number, subject: string): number {
  const projected = value ?? fallback;
  if (!Number.isSafeInteger(projected) || projected < 0 || projected > maximum) {
    throw new CommunityContextError(`${subject} must be an integer from 0 through ${String(maximum)}.`);
  }
  return projected;
}

export function normalizeCommunityContextLimits(limits?: CommunityContextLimits): EffectiveCommunityContextLimits {
  const maxDocuments = boundedInteger(limits?.maxDocuments, DEFAULT_MAXIMUM_DOCUMENTS, MAXIMUM_COMMUNITY_CONTEXT_DOCUMENTS, "maxDocuments");
  const maxBytes = boundedInteger(limits?.maxBytes, DEFAULT_MAXIMUM_BYTES, MAXIMUM_COMMUNITY_CONTEXT_BYTES, "maxBytes");
  if (maxBytes < MINIMUM_COMMUNITY_CONTEXT_BYTES) {
    throw new CommunityContextError(`maxBytes must be at least ${String(MINIMUM_COMMUNITY_CONTEXT_BYTES)}.`);
  }
  return Object.freeze({ maxBytes, maxDocuments });
}

function normalizedText(value: unknown, subject: string): string {
  if (typeof value !== "string") {throw new CommunityContextError(`${subject} must be a string.`);}
  const normalized = value.normalize("NFC");
  if (normalized.includes("\u0000") || Buffer.byteLength(normalized, "utf8") > 65_536) {
    throw new CommunityContextError(`${subject} is outside the bounded text contract.`);
  }
  return normalized;
}

function inlineText(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim();
}

function markdownText(value: string): string {
  return inlineText(value).replace(/[\\`*_[\]<>]/gu, "\\$&");
}

function relativeMarkdownLink(repositoryPath: string): string {
  const path = normalizedText(repositoryPath, "document.repositoryPath");
  if (
    path.length === 0 || path.startsWith("/") || path.startsWith("\\") ||
    /^[A-Za-z]:/u.test(path) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path) ||
    path.includes("\\") || path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new CommunityContextError(`Document path must be a canonical repository-relative path: ${path}.`);
  }
  return `./${path.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function compareDocuments(left: DocsFindDocument, right: DocsFindDocument): number {
  const leftId = left.id.normalize("NFC");
  const rightId = right.id.normalize("NFC");
  return BINARY(leftId, rightId) || BINARY(left.repositoryPath.normalize("NFC"), right.repositoryPath.normalize("NFC"));
}

function documentBlock(document: DocsFindDocument): string {
  const id = markdownText(normalizedText(document.id, "document.id"));
  const title = markdownText(normalizedText(document.title, `${document.id}.title`));
  const summary = markdownText(normalizedText(document.summary, `${document.id}.summary`));
  const type = markdownText(normalizedText(document.type, `${document.id}.type`));
  const status = markdownText(normalizedText(document.status, `${document.id}.status`));
  const owner = markdownText(normalizedText(document.owner, `${document.id}.owner`));
  const link = relativeMarkdownLink(document.repositoryPath);
  return `- [${id}: ${title}](${link})\n  - ${summary}\n  - Type: ${type}; status: ${status}; owner: ${owner}\n`;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function projectCommunityLlmsText(input: CommunityLlmsTextInput): CommunityLlmsTextProjection {
  const limits = normalizeCommunityContextLimits(input.limits);
  const { maxBytes, maxDocuments } = limits;

  // Reuse the canonicalization and duplicate checks without invoking a search adapter.
  const canonicalDocuments = rankCommunityDocuments({ documents: input.documents, query: "" })
    .map(({ document }) => document);
  const canonicalById = new Map(canonicalDocuments.map((document) => [document.id, document] as const));
  const documents = input.selection?.kind === "fuzzy-advisory"
    ? input.documents.map((document) => {
        const id = document.id.normalize("NFC");
        const canonical = canonicalById.get(id);
        if (canonical === undefined) {
          throw new CommunityContextError(`Fuzzy projection contains an unknown canonical document id: ${id}.`);
        }
        return canonical;
      })
    : canonicalDocuments.toSorted(compareDocuments);
  const projectId = markdownText(normalizedText(input.catalog.projectId, "catalog.projectId"));
  const title = markdownText(normalizedText(input.catalog.title, "catalog.title"));
  const summary = input.catalog.summary === undefined
    ? ""
    : `${markdownText(normalizedText(input.catalog.summary, "catalog.summary"))}\n\n`;
  const advisory = input.selection?.kind === "fuzzy-advisory"
    ? "> Fuzzy advisory ranking was used. Verify document authority and current status before acting.\n\n"
    : "";
  const header = `# ${title}\n\n${summary}Project: ${projectId}\n\n${advisory}## Documents\n\n`;
  if (byteLength(header) >= maxBytes) {
    throw new CommunityContextError("Catalog header leaves no room for an explicit bounded projection.");
  }

  const candidates = documents.slice(0, maxDocuments);
  const included: string[] = [];
  for (const document of candidates) {
    const block = documentBlock(document);
    const projectedIncluded = included.length + 1;
    const omitted = documents.length - projectedIncluded;
    const marker = omitted > 0
      ? `\n## Truncation\n\nIncluded ${String(projectedIncluded)} of ${String(documents.length)} documents; ${String(omitted)} omitted by maxDocuments/maxBytes limits.\n`
      : "";
    if (byteLength(`${header}${included.join("")}${block}${marker}`) > maxBytes) {break;}
    included.push(block);
  }

  const omittedDocuments = documents.length - included.length;
  const marker = omittedDocuments > 0
    ? `\n## Truncation\n\nIncluded ${String(included.length)} of ${String(documents.length)} documents; ${String(omittedDocuments)} omitted by maxDocuments/maxBytes limits.\n`
    : "";
  let content = `${header}${included.join("")}${marker}`;
  if (byteLength(content) > maxBytes) {
    // This is possible only when zero documents fit and the explicit marker itself exhausts the budget.
    content = `# ${title}\n\n## Truncation\n\n0 of ${String(documents.length)} documents included due to bounded output limits.\n`;
  }
  if (byteLength(content) > maxBytes) {
    throw new CommunityContextError("maxBytes cannot represent the catalog title and explicit truncation state.");
  }
  content = `${content.trimEnd()}\n`.normalize("NFC");
  return Object.freeze({
    content,
    includedDocuments: included.length,
    omittedDocuments,
    truncated: omittedDocuments > 0,
    limits
  });
}
