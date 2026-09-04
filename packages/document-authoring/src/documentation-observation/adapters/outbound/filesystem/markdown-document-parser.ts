import { GithubSlugger, toString, remarkFrontmatter, remarkGfm, remarkParse, unified, visit as visitMarkdown } from "../../../../adapters/markdown-runtime.js";
import {
  isAlias,
  isMap,
  isNode,
  isPair,
  parseDocument,
  visit as visitYaml
} from "yaml";

import type {
  MarkdownAnchorObservation,
  MarkdownDocumentObservation,
  MarkdownFrontmatterObservation,
  MarkdownHeadingObservation,
  MarkdownPosition,
  MarkdownReferenceObservation
} from "../../../application/model/markdown-document.js";

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

function parseMarkdown(source: string): ParsedMarkdown {
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

function hasOpeningYamlDelimiter(source: string): boolean {
  const withoutByteOrderMark = source.startsWith("\uFEFF") ? source.slice(1) : source;
  return /^---[ \t]*(?:\r?\n|$)/u.test(withoutByteOrderMark);
}

function findFrontmatter(markdown: ParsedMarkdown): AstYamlNode | undefined {
  let yaml: AstYamlNode | undefined;
  visitMarkdown(markdown.tree, (node) => {
    if (yaml === undefined && isYamlNode(node) && astPosition(node).start.offset === 0) {
      yaml = node;
    }
  });
  return yaml;
}

function forbiddenYamlFeature(document: ReturnType<typeof parseDocument>): string | undefined {
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
    if (isPair(node) && isNode(node.key) && "value" in node.key && node.key.value === "<<") {
      forbidden = "YAML merge keys are prohibited.";
      return;
    }
    if (isMap(node) && node.items.length > 10_000) {
      forbidden = "YAML mapping exceeds the supported size limit.";
    }
  });
  return forbidden;
}

function frontmatterFromMarkdown(
  source: string,
  markdown: ParsedMarkdown
): MarkdownFrontmatterObservation {
  const yaml = findFrontmatter(markdown);
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

  const forbidden = forbiddenYamlFeature(document);
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
      text: toString(node)
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

function collectReferenceNodes(markdown: ParsedMarkdown): {
  readonly definitions: readonly AstDefinitionNode[];
  readonly directReferences: readonly MarkdownReferenceObservation[];
  readonly referenceNodes: readonly AstReferenceNode[];
} {
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
  return { definitions, directReferences, referenceNodes };
}

function referencesFromMarkdown(
  markdown: ParsedMarkdown
): readonly MarkdownReferenceObservation[] {
  const { definitions, directReferences, referenceNodes } = collectReferenceNodes(markdown);
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

export function observeMarkdownDocument(
  repositoryPath: string,
  source: string
): MarkdownDocumentObservation {
  const markdown = parseMarkdown(source);
  const headings = headingsFromMarkdown(markdown);
  return {
    anchorObservations: [githubAnchorObservation(headings)],
    frontmatter: frontmatterFromMarkdown(source, markdown),
    headings,
    references: referencesFromMarkdown(markdown),
    repositoryPath,
    source
  };
}
