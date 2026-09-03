import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit as visitMarkdown } from "unist-util-visit";
import { isAlias, isNode, parseDocument, stringify, visit } from "yaml";

import { compareBinaryStrings } from "../binary-string-comparator.js";
import type {
  CanonicalDocumentInput,
  CanonicalDocumentRenderer,
  CanonicalFrontmatter,
  CanonicalFrontmatterValue,
  GovernedTemplateSkeleton
} from "../application/ports/canonical-document-renderer.js";

const MAX_TEMPLATE_BYTES = 256 * 1024;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const FOUNDATION_FRONTMATTER_KEYS = Object.freeze([
  "id",
  "type",
  "status",
  "owner",
  "summary",
  "related"
]);
const INTENT_RESERVED_KEYS = new Set([
  ...FOUNDATION_FRONTMATTER_KEYS,
  "destination",
  "slug",
  "title"
]);
const PLACEHOLDER_FRONTMATTER_PATTERN = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n+/u;
const markdownParser = unified().use(remarkParse).freeze();

interface MarkdownPoint {
  readonly offset?: number;
}

interface MarkdownNode {
  readonly depth?: number;
  readonly lang?: string | null;
  readonly meta?: string | null;
  readonly position?: {
    readonly end: MarkdownPoint;
    readonly start: MarkdownPoint;
  };
  readonly type: string;
  readonly value?: string;
}

export type CanonicalMarkdownFailure =
  | "frontmatter-invalid"
  | "template-invalid"
  | "template-limit-exceeded";

export class CanonicalMarkdownError extends Error {
  readonly failure: CanonicalMarkdownFailure;

  constructor(failure: CanonicalMarkdownFailure, message: string) {
    super(message);
    this.name = "CanonicalMarkdownError";
    this.failure = failure;
  }
}

function invalidFrontmatter(message: string): never {
  throw new CanonicalMarkdownError("frontmatter-invalid", message);
}

function invalidTemplate(message: string): never {
  throw new CanonicalMarkdownError("template-invalid", message);
}

function assertText(value: string, field: string): void {
  if (value.length === 0 || value.includes("\0") || /[\r\n]/u.test(value)) {
    invalidFrontmatter(`${field} must be a non-empty single-line string.`);
  }
  assertCanonicalUnicode(value, field);
}

function assertCanonicalUnicode(value: string, field: string): void {
  if (value.normalize("NFC") !== value) {
    invalidFrontmatter(`${field} must use Unicode NFC.`);
  }
}

function canonicalizeArray(
  value: readonly CanonicalFrontmatterValue[],
  ancestors: ReadonlySet<object>
): CanonicalFrontmatterValue[] {
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key))
    )
  ) {
    invalidFrontmatter("Frontmatter arrays must be dense and cannot have extra properties.");
  }
  const output: CanonicalFrontmatterValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (item === undefined || !("value" in item) || item.enumerable !== true) {
      invalidFrontmatter("Frontmatter arrays must contain enumerable data items.");
    }
    output.push(
      canonicalizeValue(item.value as CanonicalFrontmatterValue, ancestors)
    );
  }
  return output;
}

function canonicalizeMap(
  value: Readonly<Record<string, CanonicalFrontmatterValue>>,
  ancestors: ReadonlySet<object>
): Record<string, CanonicalFrontmatterValue> {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    invalidFrontmatter("Frontmatter mappings must be plain objects.");
  }
  const output: Record<string, CanonicalFrontmatterValue> = Object.create(null) as Record<
    string,
    CanonicalFrontmatterValue
  >;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    invalidFrontmatter("Frontmatter mappings cannot contain symbol keys.");
  }
  for (const key of (ownKeys as string[]).toSorted(compareBinaryStrings)) {
    assertCanonicalUnicode(key, "Frontmatter key");
    if (RESERVED_KEYS.has(key)) {
      invalidFrontmatter(`Frontmatter key ${key} is reserved.`);
    }
    const item = Object.getOwnPropertyDescriptor(value, key);
    if (item === undefined || !("value" in item) || item.enumerable !== true) {
      invalidFrontmatter("Frontmatter mappings cannot contain accessors.");
    }
    output[key] = canonicalizeValue(
      item.value as CanonicalFrontmatterValue,
      ancestors
    );
  }
  return output;
}

function canonicalizeValue(
  value: CanonicalFrontmatterValue,
  ancestors: ReadonlySet<object>
): CanonicalFrontmatterValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "string") {
      assertCanonicalUnicode(value, "Frontmatter string");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      invalidFrontmatter("Frontmatter numbers must be safe integers and cannot be negative zero.");
    }
    return value;
  }
  if (typeof value !== "object") {
    invalidFrontmatter("Frontmatter values must use the JSON data model.");
  }
  if (ancestors.has(value)) {
    invalidFrontmatter("Frontmatter values cannot contain cycles.");
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return canonicalizeArray(value, nextAncestors);
  }
  return canonicalizeMap(
    value as Readonly<Record<string, CanonicalFrontmatterValue>>,
    nextAncestors
  );
}

function canonicalFrontmatterObject(
  input: CanonicalFrontmatter
): Record<string, CanonicalFrontmatterValue> {
  for (const [key, value] of [
    ["id", input.id],
    ["type", input.type],
    ["status", input.status],
    ["owner", input.owner],
    ["summary", input.summary]
  ] as const) {
    assertText(value, key);
  }
  const result: Record<string, CanonicalFrontmatterValue> = Object.create(null) as Record<
    string,
    CanonicalFrontmatterValue
  >;
  result.id = input.id;
  result.type = input.type;
  result.status = input.status;
  result.owner = input.owner;
  result.summary = input.summary;
  if (input.related !== undefined) {
    const relatedSet = new Set(input.related);
    if (relatedSet.size !== input.related.length) {
      invalidFrontmatter("related must not contain duplicate identifiers.");
    }
    const relatedItems = [...input.related].toSorted(compareBinaryStrings);
    for (const related of relatedItems) {
      assertText(related, "related item");
    }
    result.related = relatedItems;
  }
  const metadata = input.additionalMetadata ?? {};
  const metadataPrototype = Object.getPrototypeOf(metadata) as object | null;
  if (metadataPrototype !== Object.prototype && metadataPrototype !== null) {
    invalidFrontmatter("Additional metadata must be a plain object.");
  }
  const metadataOwnKeys = Reflect.ownKeys(metadata);
  if (metadataOwnKeys.some((key) => typeof key !== "string")) {
    invalidFrontmatter("Additional metadata cannot contain symbol keys.");
  }
  const metadataKeys = metadataOwnKeys as string[];
  for (const key of metadataKeys) {
    assertCanonicalUnicode(key, "Frontmatter key");
    if (INTENT_RESERVED_KEYS.has(key)) {
      invalidFrontmatter(`Additional metadata cannot replace governed key ${key}.`);
    }
    if (RESERVED_KEYS.has(key)) {
      invalidFrontmatter(`Frontmatter key ${key} is reserved.`);
    }
  }
  const orderedMetadataKeys = metadataKeys.toSorted(compareBinaryStrings);
  for (const key of orderedMetadataKeys) {
    const item = Object.getOwnPropertyDescriptor(metadata, key);
    if (item === undefined || !("value" in item) || item.enumerable !== true) {
      invalidFrontmatter("Additional metadata cannot contain accessors.");
    }
    result[key] = canonicalizeValue(
      item.value as CanonicalFrontmatterValue,
      new Set<object>()
    );
  }
  return result;
}

function orderedYamlValue(value: CanonicalFrontmatterValue): unknown {
  if (Array.isArray(value)) {
    const items = value as readonly CanonicalFrontmatterValue[];
    return items.map((item) => orderedYamlValue(item));
  }
  if (value !== null && typeof value === "object") {
    const mapping = value as Readonly<Record<string, CanonicalFrontmatterValue>>;
    return new Map(
      Reflect.ownKeys(mapping)
        .map((key) => key as string)
        .toSorted(compareBinaryStrings)
        .map((key) => [key, orderedYamlValue(mapping[key] as CanonicalFrontmatterValue)])
    );
  }
  return value;
}

function orderedYamlFrontmatter(
  value: Readonly<Record<string, CanonicalFrontmatterValue>>
): ReadonlyMap<string, unknown> {
  const entries: [string, unknown][] = [];
  for (const key of FOUNDATION_FRONTMATTER_KEYS) {
    if (Object.hasOwn(value, key)) {
      entries.push([
        key,
        orderedYamlValue(value[key] as CanonicalFrontmatterValue)
      ]);
    }
  }
  const additionalKeys = Reflect.ownKeys(value)
    .map((key) => key as string)
    .filter((key) => !FOUNDATION_FRONTMATTER_KEYS.includes(key))
    .toSorted(compareBinaryStrings);
  for (const key of additionalKeys) {
    entries.push([
      key,
      orderedYamlValue(value[key] as CanonicalFrontmatterValue)
    ]);
  }
  return new Map(entries);
}

export function renderCanonicalFrontmatter(input: CanonicalFrontmatter): string {
  const value = canonicalFrontmatterObject(input);
  const rendered = stringify(orderedYamlFrontmatter(value), {
    aliasDuplicateObjects: false,
    lineWidth: 0,
    sortMapEntries: false
  }).replaceAll("\r\n", "\n");
  const parsed = parseDocument(rendered, {
    customTags: [],
    merge: false,
    schema: "core",
    uniqueKeys: true
  });
  if (parsed.errors.length > 0 || parsed.warnings.length > 0) {
    invalidFrontmatter("Canonical YAML failed strict self-validation.");
  }
  const roundTrip = parsed.toJS({ maxAliasCount: 0 }) as unknown;
  const canonicalRoundTrip = canonicalizeValue(
    roundTrip as CanonicalFrontmatterValue,
    new Set<object>()
  );
  const canonicalExpected = canonicalizeValue(value, new Set<object>());
  if (JSON.stringify(canonicalRoundTrip) !== JSON.stringify(canonicalExpected)) {
    invalidFrontmatter("Canonical YAML changed a frontmatter value during serialization.");
  }
  return rendered.trimEnd();
}

function normalizeTemplateSource(source: string): string {
  if (Buffer.byteLength(source, "utf8") > MAX_TEMPLATE_BYTES) {
    throw new CanonicalMarkdownError(
      "template-limit-exceeded",
      `Template exceeds the ${MAX_TEMPLATE_BYTES}-byte limit.`
    );
  }
  if (source.includes("\0") || /\r(?!\n)/u.test(source)) {
    invalidTemplate("Template must be NUL-free text with LF or CRLF line endings.");
  }
  if (source.normalize("NFC") !== source) {
    invalidTemplate("Template must use Unicode NFC.");
  }
  return source.replaceAll("\r\n", "\n");
}

function assertSafePlaceholderFrontmatter(source: string): void {
  const document = parseDocument(source, {
    customTags: [],
    merge: false,
    schema: "core",
    uniqueKeys: true
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    invalidTemplate("Markdown skeleton placeholder frontmatter must be valid strict YAML.");
  }
  let prohibited: { readonly found: boolean } = { found: false };
  visit(document, (_key, node) => {
    if (isAlias(node) || (isNode(node) && (node.anchor !== undefined || node.tag !== undefined))) {
      prohibited = { found: true };
      return visit.BREAK;
    }
    return;
  });
  if (prohibited.found) {
    invalidTemplate("Markdown skeleton placeholder frontmatter cannot use tags, anchors, or aliases.");
  }
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidTemplate("Markdown skeleton placeholder frontmatter must be a mapping.");
  }
  canonicalizeValue(value as CanonicalFrontmatterValue, new Set<object>());
}

function markdownNodes(source: string, type: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  const tree = markdownParser.parse(source);
  visitMarkdown(tree, type, (node) => {
    nodes.push(node as MarkdownNode);
  });
  return nodes;
}

function extractMarkdownSkeleton(source: string): string {
  const candidates = markdownNodes(source, "code").filter(
    (node) => node.lang === "markdown" && (node.meta === null || node.meta === undefined)
  );
  if (candidates.length !== 1) {
    invalidTemplate("Template must contain exactly one fenced markdown skeleton.");
  }
  const candidate = candidates[0];
  const start = candidate?.position?.start.offset;
  const end = candidate?.position?.end.offset;
  if (start === undefined || end === undefined) {
    invalidTemplate("Markdown skeleton must have a bounded source position.");
  }
  const fenced = source.slice(start, end);
  const opening = /^(?<fence>`{3,})markdown[ \t]*\n/u.exec(fenced);
  if (opening?.groups?.fence === undefined) {
    invalidTemplate("Markdown skeleton must use a backtick fence and exact markdown info string.");
  }
  const closingStart = fenced.lastIndexOf("\n") + 1;
  const closing = fenced.slice(closingStart);
  if (!new RegExp(`^${opening.groups.fence}[ \\t]*$`, "u").test(closing)) {
    invalidTemplate("Markdown skeleton fence must be closed canonically.");
  }
  return fenced.slice(opening[0].length, closingStart - 1);
}

function leadingH1(source: string): { readonly heading: string; readonly end: number } {
  const headings = markdownNodes(source, "heading").filter((node) => node.depth === 1);
  const first = headings[0];
  const start = first?.position?.start.offset;
  const end = first?.position?.end.offset;
  if (headings.length !== 1 || first?.depth !== 1 || start !== 0 || end === undefined) {
    invalidTemplate("Markdown skeleton must contain exactly one leading H1 heading.");
  }
  const line = source.slice(0, end);
  const match = /^# (?<heading>[^\n]+)$/u.exec(line);
  const heading = match?.groups?.heading;
  if (heading === undefined || heading.trim() !== heading || heading.length === 0) {
    invalidTemplate("Markdown skeleton H1 must contain a non-empty canonical ATX heading.");
  }
  return { end, heading };
}

export function parseGovernedTemplateSkeleton(
  source: string
): GovernedTemplateSkeleton {
  const normalized = normalizeTemplateSource(source);
  const skeleton = extractMarkdownSkeleton(normalized);
  const frontmatter = PLACEHOLDER_FRONTMATTER_PATTERN.exec(skeleton);
  if (frontmatter === null) {
    invalidTemplate("Markdown skeleton must begin with placeholder frontmatter.");
  }
  assertSafePlaceholderFrontmatter(frontmatter[1] ?? "");
  const bodyWithHeading = skeleton.slice(frontmatter[0].length);
  const heading = leadingH1(bodyWithHeading);
  const placeholderHeading = heading.heading;
  const headingEnd = heading.end;
  const body = bodyWithHeading.slice(headingEnd);
  if (body.length > 0 && !body.startsWith("\n\n")) {
    invalidTemplate("Markdown skeleton H1 must be followed by one blank line.");
  }
  return Object.freeze({
    body: body.length === 0 ? "" : body.slice(2).replace(/\n+$/u, ""),
    placeholderHeading
  });
}

export function renderCanonicalDocument(input: CanonicalDocumentInput): string {
  assertText(input.heading, "heading");
  const body = input.template.body.replace(/\n+$/u, "");
  const suffix = body.length === 0 ? "" : `\n\n${body}`;
  return `---\n${renderCanonicalFrontmatter(input.frontmatter)}\n---\n\n# ${input.heading}${suffix}\n`;
}

export class YamlCanonicalDocumentRenderer implements CanonicalDocumentRenderer {
  parseTemplate(source: string): GovernedTemplateSkeleton {
    return parseGovernedTemplateSkeleton(source);
  }

  render(input: CanonicalDocumentInput): string {
    return renderCanonicalDocument(input);
  }
}
