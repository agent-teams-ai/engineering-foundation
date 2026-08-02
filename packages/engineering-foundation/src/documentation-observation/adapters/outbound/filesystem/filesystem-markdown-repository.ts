import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat
} from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import GithubSlugger from "github-slugger";
import { toString } from "mdast-util-to-string";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit as visitMarkdown } from "unist-util-visit";
import {
  isAlias,
  isMap,
  isNode,
  isPair,
  parseDocument,
  visit as visitYaml
} from "yaml";

import { assertNotCancelled } from "../../../../strict-yaml.js";
import { pathTraversesSymbolicLink } from "../../../../filesystem-path-safety.js";
import type {
  MarkdownAnchorObservation,
  MarkdownDocumentObservation,
  MarkdownFrontmatterObservation,
  MarkdownHeadingObservation,
  MarkdownObservationIssue,
  MarkdownPosition,
  MarkdownReferenceObservation,
  MarkdownReferenceResolution,
  MarkdownRepositoryObservation
} from "../../../application/model/markdown-document.js";
import type {
  MarkdownRepository,
  ObserveMarkdownRepositoryRequest,
  ResolveMarkdownReferenceRequest
} from "../../../application/ports/markdown-repository.js";

const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;
const SKIPPED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);

const markdownParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ["yaml"])
  .freeze();

interface AstPoint {
  readonly column: number;
  readonly line: number;
  readonly offset: number;
}

interface AstPosition {
  readonly end: AstPoint;
  readonly start: AstPoint;
}

interface AstNode {
  readonly position?: unknown;
  readonly type: string;
}

interface AstDefinitionNode extends AstNode {
  readonly identifier: string;
  readonly type: "definition";
  readonly url: string;
}

interface AstHeadingNode extends AstNode {
  readonly depth: number;
  readonly type: "heading";
}

interface AstReferenceNode extends AstNode {
  readonly identifier: string;
  readonly type: "imageReference" | "linkReference";
}

interface AstUrlNode extends AstNode {
  readonly type: "image" | "link";
  readonly url: string;
}

interface AstYamlNode extends AstNode {
  readonly type: "yaml";
  readonly value: string;
}

interface ParsedMarkdown {
  readonly sourceOffset: number;
  readonly tree: ReturnType<typeof markdownParser.parse>;
}

interface RepositoryContext {
  readonly canonicalRoot: string;
}

function repositoryPath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

function withinRoot(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function astProperty(value: AstNode, property: string): unknown {
  return Reflect.get(value, property);
}

function isAstPoint(value: unknown): value is AstPoint {
  return (
    typeof value === "object" &&
    value !== null &&
    "column" in value &&
    typeof value.column === "number" &&
    "line" in value &&
    typeof value.line === "number" &&
    "offset" in value &&
    typeof value.offset === "number"
  );
}

function isAstPosition(value: unknown): value is AstPosition {
  return (
    typeof value === "object" &&
    value !== null &&
    "start" in value &&
    isAstPoint(value.start) &&
    "end" in value &&
    isAstPoint(value.end)
  );
}

function isDefinitionNode(value: unknown): value is AstDefinitionNode {
  return (
    isAstNode(value) &&
    value.type === "definition" &&
    typeof astProperty(value, "identifier") === "string" &&
    typeof astProperty(value, "url") === "string"
  );
}

function isHeadingNode(value: unknown): value is AstHeadingNode {
  return (
    isAstNode(value) &&
    value.type === "heading" &&
    typeof astProperty(value, "depth") === "number"
  );
}

function isReferenceNode(value: unknown): value is AstReferenceNode {
  return (
    isAstNode(value) &&
    (value.type === "imageReference" || value.type === "linkReference") &&
    typeof astProperty(value, "identifier") === "string"
  );
}

function isUrlNode(value: unknown): value is AstUrlNode {
  return (
    isAstNode(value) &&
    (value.type === "image" || value.type === "link") &&
    typeof astProperty(value, "url") === "string"
  );
}

function isYamlNode(value: unknown): value is AstYamlNode {
  return isAstNode(value) && value.type === "yaml" && typeof astProperty(value, "value") === "string";
}

function parsedMarkdown(source: string): ParsedMarkdown {
  const sourceOffset = source.startsWith("\uFEFF") ? 1 : 0;
  return {
    sourceOffset,
    tree: markdownParser.parse(source.slice(sourceOffset))
  };
}

function astPosition(node: AstNode): AstPosition {
  const position = node.position;
  if (!isAstPosition(position)) {
    throw new Error(`Markdown AST node ${node.type} has no source position.`);
  }
  return position;
}

function markdownPosition(node: AstNode, sourceOffset: number): MarkdownPosition {
  const point = astPosition(node).start;
  return {
    column: point.column + (point.line === 1 ? sourceOffset : 0),
    line: point.line,
    offset: point.offset + sourceOffset
  };
}

function endOffsetAfterLineEnding(
  source: string,
  node: AstNode,
  sourceOffset: number
): number {
  const endOffset = astPosition(node).end.offset + sourceOffset;
  if (source.startsWith("\r\n", endOffset)) {
    return endOffset + 2;
  }
  return source.startsWith("\n", endOffset) ? endOffset + 1 : endOffset;
}

function markdownText(node: AstNode): string {
  return toString(node);
}

function hasOpeningYamlDelimiter(source: string): boolean {
  const withoutByteOrderMark = source.startsWith("\uFEFF") ? source.slice(1) : source;
  return /^---[ \t]*(?:\r?\n|$)/u.test(withoutByteOrderMark);
}

function frontmatterFromMarkdown(
  source: string,
  markdown: ParsedMarkdown
): MarkdownFrontmatterObservation {
  let yaml: AstYamlNode | undefined;
  visitMarkdown(markdown.tree, (node) => {
    if (yaml !== undefined || !isYamlNode(node)) {
      return;
    }
    if (astPosition(node).start.offset === 0) {
      yaml = node;
    }
  });

  if (yaml === undefined) {
    return hasOpeningYamlDelimiter(source)
      ? {
          endOffset: source.length,
          kind: "invalid",
          message: "YAML frontmatter is missing a closing delimiter."
        }
      : { endOffset: 0, kind: "absent" };
  }

  const endOffset = endOffsetAfterLineEnding(source, yaml, markdown.sourceOffset);
  const document = parseDocument(yaml.value, {
    customTags: [],
    merge: false,
    schema: "core",
    uniqueKeys: true
  });
  const errors = [...document.errors, ...document.warnings];
  if (errors.length > 0) {
    return {
      endOffset,
      kind: "invalid",
      message: errors
        .slice(0, 4)
        .map((error) => error.message)
        .join("; ")
        .slice(0, 1000)
    };
  }

  let forbidden: string | undefined;
  visitYaml(document, (_key, node) => {
    if (forbidden !== undefined) {
      return;
    }
    if (isAlias(node)) {
      forbidden = "YAML aliases are prohibited.";
      return;
    }
    if (isNode(node) && (node.anchor !== undefined || node.tag !== undefined)) {
      forbidden = "YAML anchors and explicit tags are prohibited.";
      return;
    }
    if (
      isPair(node) &&
      isNode(node.key) &&
      "value" in node.key &&
      node.key.value === "<<"
    ) {
      forbidden = "YAML merge keys are prohibited.";
      return;
    }
    if (isMap(node) && node.items.length > 10_000) {
      forbidden = "YAML mapping exceeds the supported size limit.";
    }
  });
  if (forbidden !== undefined) {
    return { endOffset, kind: "invalid", message: forbidden };
  }
  return {
    endOffset,
    kind: "valid",
    value: document.toJS({ maxAliasCount: 0 }) as unknown
  };
}

function headingsFromMarkdown(
  markdown: ParsedMarkdown
): readonly MarkdownHeadingObservation[] {
  const headings: MarkdownHeadingObservation[] = [];
  visitMarkdown(markdown.tree, (node) => {
    if (!isHeadingNode(node)) {
      return;
    }
    headings.push({
      depth: node.depth,
      location: markdownPosition(node, markdown.sourceOffset),
      text: markdownText(node)
    });
  });
  return headings.toSorted((left, right) => left.location.offset - right.location.offset);
}

function githubAnchorObservation(
  headings: readonly MarkdownHeadingObservation[]
): MarkdownAnchorObservation {
  const slugger = new GithubSlugger();
  return {
    ids: headings.map((heading) => slugger.slug(heading.text)),
    profile: "github"
  };
}

function referenceFromNode(
  node: AstNode,
  kind: "definition" | "image" | "link",
  rawTarget: string,
  sourceOffset: number
): MarkdownReferenceObservation {
  return {
    kind,
    location: markdownPosition(node, sourceOffset),
    rawTarget
  };
}

function referencesFromMarkdown(
  markdown: ParsedMarkdown
): readonly MarkdownReferenceObservation[] {
  const definitions: AstDefinitionNode[] = [];
  const directReferences: MarkdownReferenceObservation[] = [];
  const referenceNodes: AstReferenceNode[] = [];

  visitMarkdown(markdown.tree, (node) => {
    if (isDefinitionNode(node)) {
      definitions.push(node);
      return;
    }
    if (isUrlNode(node)) {
      directReferences.push(
        referenceFromNode(node, node.type === "image" ? "image" : "link", node.url, markdown.sourceOffset)
      );
      return;
    }
    if (isReferenceNode(node)) {
      referenceNodes.push(node);
    }
  });

  const effectiveDefinitions = new Map<string, AstDefinitionNode>();
  for (const definition of definitions) {
    if (!effectiveDefinitions.has(definition.identifier)) {
      effectiveDefinitions.set(definition.identifier, definition);
    }
  }

  const referencedDefinitions = new Set<AstDefinitionNode>();
  const resolvedReferenceUsages = referenceNodes.flatMap((node) => {
    const definition = effectiveDefinitions.get(node.identifier);
    if (definition === undefined) {
      return [];
    }
    referencedDefinitions.add(definition);
    return [
      referenceFromNode(
        node,
        node.type === "imageReference" ? "image" : "link",
        definition.url,
        markdown.sourceOffset
      )
    ];
  });

  const unusedDefinitions = definitions.flatMap((definition) => {
    if (
      effectiveDefinitions.get(definition.identifier) !== definition ||
      referencedDefinitions.has(definition)
    ) {
      return [];
    }
    return [
      referenceFromNode(
        definition,
        "definition",
        definition.url,
        markdown.sourceOffset
      )
    ];
  });

  return [...directReferences, ...resolvedReferenceUsages, ...unusedDefinitions].toSorted(
    (left, right) => left.location.offset - right.location.offset
  );
}

function observeMarkdownDocument(
  documentRepositoryPath: string,
  source: string
): MarkdownDocumentObservation {
  const markdown = parsedMarkdown(source);
  const headings = headingsFromMarkdown(markdown);
  return {
    anchorObservations: [githubAnchorObservation(headings)],
    frontmatter: frontmatterFromMarkdown(source, markdown),
    headings,
    references: referencesFromMarkdown(markdown),
    repositoryPath: documentRepositoryPath,
    source
  };
}

function unescapeMarkdownDestination(value: string): string {
  return value.replace(/\\(.)/gu, "$1");
}

function splitTargetAndFragment(rawTarget: string):
  | { readonly fragment: string; readonly target: string }
  | undefined {
  let escapedCharacter = false;
  for (let index = 0; index < rawTarget.length; index += 1) {
    const character = rawTarget[index];
    if (escapedCharacter) {
      escapedCharacter = false;
      continue;
    }
    if (character === "\\") {
      escapedCharacter = true;
      continue;
    }
    if (character === "#") {
      return {
        fragment: rawTarget.slice(index + 1),
        target: rawTarget.slice(0, index)
      };
    }
  }
  return { fragment: "", target: rawTarget };
}

function externalReference(rawTarget: string): boolean {
  return rawTarget.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(rawTarget);
}

function decoded(value: string): string | undefined {
  try {
    return decodeURIComponent(unescapeMarkdownDestination(value));
  } catch {
    return undefined;
  }
}

function stripQuery(value: string): string {
  const queryStart = value.indexOf("?");
  return queryStart === -1 ? value : value.slice(0, queryStart);
}

export class FilesystemMarkdownRepository implements MarkdownRepository {
  readonly #documents = new Map<string, MarkdownDocumentObservation>();

  async observe(
    request: ObserveMarkdownRepositoryRequest
  ): Promise<MarkdownRepositoryObservation> {
    assertNotCancelled(request.signal);
    const context = await this.repositoryContext(request.consumerRoot);
    const documents = new Map<string, MarkdownDocumentObservation>();
    const issues: MarkdownObservationIssue[] = [];

    for (const root of request.roots.toSorted()) {
      await this.walkRoot(context, root, documents, issues, request.signal);
    }

    return {
      documents: [...documents.values()].toSorted((left, right) =>
        left.repositoryPath.localeCompare(right.repositoryPath)
      ),
      issues: issues.toSorted((left, right) =>
        left.repositoryPath.localeCompare(right.repositoryPath) ||
        left.kind.localeCompare(right.kind)
      )
    };
  }

  async resolveReference(
    request: ResolveMarkdownReferenceRequest
  ): Promise<MarkdownReferenceResolution> {
    assertNotCancelled(request.signal);
    const context = await this.repositoryContext(request.consumerRoot);
    const split = splitTargetAndFragment(request.rawTarget);
    if (split === undefined) {
      return { kind: "unsafe", reason: "invalid-encoding" };
    }
    const targetValue = decoded(split.target);
    const fragment = decoded(split.fragment);
    if (targetValue === undefined || fragment === undefined) {
      return { kind: "unsafe", reason: "invalid-encoding" };
    }
    if (
      targetValue.toLowerCase().startsWith("file:") ||
      /^[A-Za-z]:[\\/]/u.test(targetValue)
    ) {
      return { kind: "unsafe", reason: "absolute-path" };
    }
    if (externalReference(targetValue)) {
      return { kind: "external" };
    }
    if (targetValue.includes("\\") || targetValue.startsWith("/")) {
      return { kind: "unsafe", reason: "absolute-path" };
    }

    const sourcePath = resolve(context.canonicalRoot, request.source.repositoryPath);
    const candidate = targetValue.length === 0
      ? sourcePath
      : resolve(sourcePath, "..", stripQuery(targetValue));
    if (!withinRoot(context.canonicalRoot, candidate)) {
      return { kind: "unsafe", reason: "repository-escape" };
    }
    if (await pathTraversesSymbolicLink(context.canonicalRoot, candidate)) {
      return { kind: "unsafe", reason: "symbolic-link" };
    }

    let target = candidate;
    let targetMetadata;
    try {
      targetMetadata = await lstat(target);
    } catch {
      return {
        kind: "missing",
        reason: "target-missing",
        repositoryPath: repositoryPath(context.canonicalRoot, target)
      };
    }
    if (targetMetadata.isSymbolicLink()) {
      return { kind: "unsafe", reason: "symbolic-link" };
    }
    if (targetMetadata.isDirectory()) {
      target = resolve(target, "README.md");
      if (await pathTraversesSymbolicLink(context.canonicalRoot, target)) {
        return { kind: "unsafe", reason: "symbolic-link" };
      }
      try {
        targetMetadata = await lstat(target);
      } catch {
        return {
          kind: "missing",
          reason: "directory-readme-missing",
          repositoryPath: repositoryPath(context.canonicalRoot, target)
        };
      }
    }
    if (targetMetadata.isSymbolicLink()) {
      return { kind: "unsafe", reason: "symbolic-link" };
    }
    if (!targetMetadata.isFile()) {
      return {
        kind: "missing",
        reason: "target-missing",
        repositoryPath: repositoryPath(context.canonicalRoot, target)
      };
    }

    const targetRepositoryPath = repositoryPath(context.canonicalRoot, target);
    if (extname(target).toLowerCase() !== ".md") {
      return {
        fragment,
        kind: "file",
        repositoryPath: targetRepositoryPath
      };
    }
    const document = await this.readMarkdownDocument(context, target, request.signal);
    if (document === undefined) {
      return {
        kind: "missing",
        reason: "target-missing",
        repositoryPath: targetRepositoryPath
      };
    }
    return {
      fragment,
      kind: "file",
      markdownDocument: document,
      repositoryPath: targetRepositoryPath
    };
  }

  async repositoryContext(consumerRoot: string): Promise<RepositoryContext> {
    const canonicalRoot = await realpath(consumerRoot);
    const metadata = await stat(canonicalRoot);
    if (!metadata.isDirectory()) {
      throw new Error("Consumer root must be a directory.");
    }
    return { canonicalRoot };
  }

  async walkRoot(
    context: RepositoryContext,
    root: string,
    documents: Map<string, MarkdownDocumentObservation>,
    issues: MarkdownObservationIssue[],
    signal?: AbortSignal
  ): Promise<void> {
    const absoluteRoot = resolve(context.canonicalRoot, root);
    if (!withinRoot(context.canonicalRoot, absoluteRoot)) {
      issues.push({
        kind: "symbolic-link",
        message: "Configured Markdown root escapes the consumer repository.",
        repositoryPath: root
      });
      return;
    }
    if (await pathTraversesSymbolicLink(context.canonicalRoot, absoluteRoot)) {
      issues.push({
        kind: "symbolic-link",
        message: "Configured Markdown root traverses a symbolic link.",
        repositoryPath: root
      });
      return;
    }
    let metadata;
    try {
      metadata = await lstat(absoluteRoot);
    } catch {
      issues.push({
        kind: "root-missing",
        message: "Configured Markdown root does not exist.",
        repositoryPath: root
      });
      return;
    }
    if (metadata.isSymbolicLink()) {
      issues.push({
        kind: "symbolic-link",
        message: "Configured Markdown root must not be a symbolic link.",
        repositoryPath: root
      });
      return;
    }
    if (!metadata.isDirectory()) {
      issues.push({
        kind: "root-not-directory",
        message: "Configured Markdown root must be a directory.",
        repositoryPath: root
      });
      return;
    }
    await this.walkDirectory(context, absoluteRoot, documents, issues, signal);
  }

  async walkDirectory(
    context: RepositoryContext,
    directory: string,
    documents: Map<string, MarkdownDocumentObservation>,
    issues: MarkdownObservationIssue[],
    signal?: AbortSignal
  ): Promise<void> {
    assertNotCancelled(signal);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      assertNotCancelled(signal);
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }
      const candidate = resolve(directory, entry.name);
      const candidateRepositoryPath = repositoryPath(context.canonicalRoot, candidate);
      let metadata;
      try {
        metadata = await lstat(candidate);
      } catch {
        issues.push({
          kind: "source-unreadable",
          message: "Markdown source entry could not be inspected.",
          repositoryPath: candidateRepositoryPath
        });
        continue;
      }
      if (metadata.isSymbolicLink()) {
        issues.push({
          kind: "symbolic-link",
          message: "Markdown source tree must not contain symbolic links.",
          repositoryPath: candidateRepositoryPath
        });
        continue;
      }
      if (metadata.isDirectory()) {
        await this.walkDirectory(context, candidate, documents, issues, signal);
        continue;
      }
      if (!metadata.isFile() || extname(entry.name).toLowerCase() !== ".md") {
        continue;
      }
      if (metadata.size > MAX_MARKDOWN_BYTES) {
        issues.push({
          kind: "source-too-large",
          message: `Markdown source exceeds ${MAX_MARKDOWN_BYTES} bytes.`,
          repositoryPath: candidateRepositoryPath
        });
        continue;
      }
      const document = await this.readMarkdownDocument(context, candidate, signal);
      if (document === undefined) {
        issues.push({
          kind: "source-unreadable",
          message: "Markdown source could not be read.",
          repositoryPath: candidateRepositoryPath
        });
        continue;
      }
      documents.set(document.repositoryPath, document);
    }
  }

  async readMarkdownDocument(
    context: RepositoryContext,
    absolutePath: string,
    signal?: AbortSignal
  ): Promise<MarkdownDocumentObservation | undefined> {
    assertNotCancelled(signal);
    const cached = this.#documents.get(absolutePath);
    if (cached !== undefined) {
      return cached;
    }
    if (await pathTraversesSymbolicLink(context.canonicalRoot, absolutePath)) {
      return undefined;
    }
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch {
      return undefined;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_MARKDOWN_BYTES) {
      return undefined;
    }
    try {
      const source = await readFile(absolutePath, "utf8");
      assertNotCancelled(signal);
      const document = observeMarkdownDocument(
        repositoryPath(context.canonicalRoot, absolutePath),
        source
      );
      this.#documents.set(absolutePath, document);
      return document;
    } catch {
      return undefined;
    }
  }
}
