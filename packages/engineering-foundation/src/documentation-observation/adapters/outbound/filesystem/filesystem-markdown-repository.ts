import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat
} from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  isAlias,
  isMap,
  isNode,
  isPair,
  parseDocument,
  visit
} from "yaml";

import { assertNotCancelled } from "../../../../strict-yaml.js";
import { pathTraversesSymbolicLink } from "../../../../filesystem-path-safety.js";
import type {
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

interface SourceLine {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

interface Range {
  readonly end: number;
  readonly start: number;
}

interface ParsedDestination {
  readonly end: number;
  readonly rawTarget: string;
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

function sourceLines(source: string): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < source.length) {
    const lineBreak = source.indexOf("\n", start);
    const end = lineBreak === -1 ? source.length : lineBreak;
    const rawLine = source.slice(start, end);
    lines.push({
      end,
      start,
      text: rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
    });
    if (lineBreak === -1) {
      break;
    }
    start = lineBreak + 1;
  }
  return lines;
}

function positionForOffset(lines: readonly SourceLine[], offset: number): MarkdownPosition {
  const lineIndex = lines.findIndex((line) => offset >= line.start && offset <= line.end);
  const line = lines[lineIndex === -1 ? Math.max(lines.length - 1, 0) : lineIndex];
  return {
    column: offset - (line?.start ?? 0) + 1,
    line: (lineIndex === -1 ? lines.length : lineIndex + 1) || 1,
    offset
  };
}

function frontmatterFromSource(source: string, lines: readonly SourceLine[]): MarkdownFrontmatterObservation {
  const first = lines[0];
  if (first === undefined || first.text.replace(/^\uFEFF/u, "") !== "---") {
    return { endOffset: 0, kind: "absent" };
  }

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && /^(?:---|\.\.\.)\s*$/u.test(line.text)) {
      const raw = source.slice(first.end + 1, line.start);
      const document = parseDocument(raw, {
        customTags: [],
        merge: false,
        schema: "core",
        uniqueKeys: true
      });
      const errors = [...document.errors, ...document.warnings];
      if (errors.length > 0) {
        return {
          endOffset: Math.min(source.length, line.end + 1),
          kind: "invalid",
          message: errors
            .slice(0, 4)
            .map((error) => error.message)
            .join("; ")
            .slice(0, 1000)
        };
      }

      let forbidden: string | undefined;
      visit(document, (_key, node) => {
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
        return {
          endOffset: Math.min(source.length, line.end + 1),
          kind: "invalid",
          message: forbidden
        };
      }
      return {
        endOffset: Math.min(source.length, line.end + 1),
        kind: "valid",
        value: document.toJS({ maxAliasCount: 0 }) as unknown
      };
    }
  }

  return {
    endOffset: source.length,
    kind: "invalid",
    message: "YAML frontmatter is missing a closing delimiter."
  };
}

function codeFenceRanges(lines: readonly SourceLine[], frontmatterEnd: number): readonly Range[] {
  const ranges: Range[] = [];
  let open: { readonly length: number; readonly marker: string; readonly start: number } | undefined;

  for (const line of lines) {
    if (line.start < frontmatterEnd) {
      continue;
    }
    if (open === undefined) {
      const match = line.text.match(/^ {0,3}(`{3,}|~{3,})/u);
      if (match?.[1] !== undefined) {
        open = {
          length: match[1].length,
          marker: match[1][0] ?? "`",
          start: line.start
        };
      }
      continue;
    }

    const closing = new RegExp(
      `^ {0,3}${open.marker}{${open.length},}[ \\t]*$`,
      "u"
    );
    if (closing.test(line.text)) {
      ranges.push({ end: line.end, start: open.start });
      open = undefined;
    }
  }

  if (open !== undefined) {
    const last = lines.at(-1);
    ranges.push({ end: last?.end ?? open.start, start: open.start });
  }
  return ranges;
}

function inRange(offset: number, ranges: readonly Range[]): boolean {
  return ranges.some((range) => offset >= range.start && offset <= range.end);
}

function overlapsRange(start: number, end: number, ranges: readonly Range[]): boolean {
  return ranges.some((range) => start <= range.end && end >= range.start);
}

function escaped(source: string, offset: number): boolean {
  let slashes = 0;
  for (let index = offset - 1; index >= 0 && source[index] === "\\"; index -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function findBracketClose(source: string, openOffset: number, ranges: readonly Range[]): number {
  let depth = 1;
  for (let index = openOffset + 1; index < source.length; index += 1) {
    if (inRange(index, ranges)) {
      return -1;
    }
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function skipInlineCode(source: string, start: number, ranges: readonly Range[]): number {
  let ticks = 1;
  while (source[start + ticks] === "`") {
    ticks += 1;
  }
  const delimiter = "`".repeat(ticks);
  for (let index = start + ticks; index < source.length; index += 1) {
    if (inRange(index, ranges)) {
      return start + ticks;
    }
    if (source.startsWith(delimiter, index)) {
      return index + ticks;
    }
  }
  return start + ticks;
}

function parseInlineDestination(
  source: string,
  openingParenthesis: number,
  ranges: readonly Range[]
): ParsedDestination | undefined {
  let cursor = openingParenthesis + 1;
  while (/[ \t\r\n]/u.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  const targetStart = cursor;
  if (source[cursor] === ")") {
    return { end: cursor + 1, rawTarget: "" };
  }
  if (source[cursor] === "<") {
    cursor += 1;
    const destinationStart = cursor;
    let rawTarget = "";
    while (cursor < source.length) {
      if (inRange(cursor, ranges)) {
        return undefined;
      }
      if (source[cursor] === ">" && !escaped(source, cursor)) {
        rawTarget = source.slice(destinationStart, cursor);
        cursor += 1;
        break;
      }
      cursor += 1;
    }
    if (cursor > source.length || source[cursor - 1] !== ">") {
      return undefined;
    }
    while (cursor < source.length && source[cursor] !== ")") {
      if (inRange(cursor, ranges)) {
        return undefined;
      }
      cursor += 1;
    }
    return source[cursor] === ")" ? { end: cursor + 1, rawTarget } : undefined;
  }

  let nestedParentheses = 0;
  while (cursor < source.length) {
    if (inRange(cursor, ranges)) {
      return undefined;
    }
    const character = source[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === "(") {
      nestedParentheses += 1;
      cursor += 1;
      continue;
    }
    if (character === ")") {
      if (nestedParentheses === 0) {
        return {
          end: cursor + 1,
          rawTarget: source.slice(targetStart, cursor).trim()
        };
      }
      nestedParentheses -= 1;
      cursor += 1;
      continue;
    }
    if (/[ \t\r\n]/u.test(character ?? "")) {
      const rawTarget = source.slice(targetStart, cursor);
      while (cursor < source.length && source[cursor] !== ")") {
        if (inRange(cursor, ranges)) {
          return undefined;
        }
        cursor += 1;
      }
      return source[cursor] === ")" ? { end: cursor + 1, rawTarget } : undefined;
    }
    cursor += 1;
  }
  return undefined;
}

function parseDefinitionDestination(
  line: SourceLine,
  start: number
): string | undefined {
  let cursor = start;
  while (/[ \t]/u.test(line.text[cursor - line.start] ?? "")) {
    cursor += 1;
  }
  if (cursor >= line.end) {
    return undefined;
  }
  if (line.text[cursor - line.start] === "<") {
    const end = line.text.indexOf(">", cursor - line.start + 1);
    return end === -1
      ? undefined
      : line.text.slice(cursor - line.start + 1, end).trim();
  }
  const remainder = line.text.slice(cursor - line.start);
  const match = remainder.match(/^([^ \t]+)/u);
  return match?.[1];
}

function inlineReferences(
  source: string,
  lines: readonly SourceLine[],
  excludedRanges: readonly Range[]
): readonly MarkdownReferenceObservation[] {
  const references: MarkdownReferenceObservation[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (inRange(index, excludedRanges)) {
      continue;
    }
    const character = source[index];
    if (character === "`" && !escaped(source, index)) {
      index = skipInlineCode(source, index, excludedRanges) - 1;
      continue;
    }
    const image = character === "!" && source[index + 1] === "[";
    const openingBracket = image ? index + 1 : index;
    if (source[openingBracket] !== "[" || escaped(source, openingBracket)) {
      continue;
    }
    const closingBracket = findBracketClose(source, openingBracket, excludedRanges);
    if (closingBracket === -1 || source[closingBracket + 1] !== "(") {
      continue;
    }
    const destination = parseInlineDestination(
      source,
      closingBracket + 1,
      excludedRanges
    );
    if (destination === undefined || overlapsRange(index, destination.end, excludedRanges)) {
      continue;
    }
    references.push({
      kind: image ? "image" : "link",
      location: positionForOffset(lines, index),
      rawTarget: destination.rawTarget
    });
    index = destination.end - 1;
  }
  return references;
}

function definitionReferences(
  source: string,
  lines: readonly SourceLine[],
  excludedRanges: readonly Range[]
): readonly MarkdownReferenceObservation[] {
  const references: MarkdownReferenceObservation[] = [];
  for (const line of lines) {
    if (inRange(line.start, excludedRanges)) {
      continue;
    }
    const match = line.text.match(/^ {0,3}\[([^\]]+)\]:/u);
    if (match?.[0] === undefined) {
      continue;
    }
    const rawTarget = parseDefinitionDestination(line, line.start + match[0].length);
    if (rawTarget === undefined) {
      continue;
    }
    references.push({
      kind: "definition",
      location: positionForOffset(lines, line.start),
      rawTarget
    });
  }
  return references;
}

function headings(
  lines: readonly SourceLine[],
  excludedRanges: readonly Range[]
): readonly MarkdownHeadingObservation[] {
  const output: MarkdownHeadingObservation[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || inRange(line.start, excludedRanges)) {
      continue;
    }
    const atx = line.text.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/u);
    if (atx?.[1] !== undefined) {
      const rawText = atx[2] ?? "";
      output.push({
        depth: atx[1].length,
        location: positionForOffset(lines, line.start),
        text: rawText.replace(/[ \t]+#+[ \t]*$/u, "").trim()
      });
      continue;
    }
    const underline = lines[index + 1];
    if (
      line.text.trim().length > 0 &&
      underline !== undefined &&
      !inRange(underline.start, excludedRanges)
    ) {
      const setext = underline.text.match(/^ {0,3}(=+|-+)[ \t]*$/u);
      if (setext?.[1] !== undefined) {
        output.push({
          depth: setext[1][0] === "=" ? 1 : 2,
          location: positionForOffset(lines, line.start),
          text: line.text.trim()
        });
        index += 1;
      }
    }
  }
  return output;
}

function observeMarkdownDocument(
  documentRepositoryPath: string,
  source: string
): MarkdownDocumentObservation {
  const lines = sourceLines(source);
  const frontmatter = frontmatterFromSource(source, lines);
  const excludedRanges = [
    ...(frontmatter.endOffset > 0
      ? [{ end: frontmatter.endOffset - 1, start: 0 }]
      : []),
    ...codeFenceRanges(lines, frontmatter.endOffset)
  ];
  return {
    frontmatter,
    headings: headings(lines, excludedRanges),
    references: [
      ...definitionReferences(source, lines, excludedRanges),
      ...inlineReferences(source, lines, excludedRanges)
    ].toSorted((left, right) => left.location.offset - right.location.offset),
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
