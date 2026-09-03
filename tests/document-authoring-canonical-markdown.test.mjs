import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CanonicalMarkdownError,
  parseGovernedTemplateSkeleton,
  renderCanonicalDocument,
  renderCanonicalFrontmatter,
  YamlCanonicalDocumentRenderer,
} from "../packages/document-authoring/dist/adapters/canonical-markdown.js";

const fixtureRoot = new URL("fixtures/document-authoring-canonical-markdown/", import.meta.url);

async function fixture(name) {
  return readFile(fileURLToPath(new URL(name, fixtureRoot)), "utf8");
}

const frontmatter = {
  id: "ADR-9001",
  type: "adr",
  status: "proposed",
  owner: "architecture/tooling",
  summary: "Freezes the current ADR document creation contract.",
  related: ["OD-001", "ADR-0001"],
  additionalMetadata: {
    code_anchors: [
      { pattern: "packages/example/*.ts", enforcement: "required" },
    ],
    blocked_by: ["OD-001"],
  },
};

test("renders the frozen donor-like document bytes", async () => {
  const renderer = new YamlCanonicalDocumentRenderer();
  const template = renderer.parseTemplate(await fixture("adr-template.md"));
  const rendered = renderer.render({
    frontmatter,
    heading: "ADR-9001: Frozen ADR",
    template,
  });
  assert.equal(rendered, await fixture("adr-golden.md"));
  assert.equal(template.placeholderHeading, "ADR-NNNN: Decision Title");
});

test("has CRLF parity and emits only LF with exactly one terminal newline", async () => {
  const lf = await fixture("adr-template.md");
  const input = {
    frontmatter,
    heading: "ADR-9001: Frozen ADR",
  };
  const fromLf = renderCanonicalDocument({
    ...input,
    template: parseGovernedTemplateSkeleton(lf),
  });
  const fromCrLf = renderCanonicalDocument({
    ...input,
    template: parseGovernedTemplateSkeleton(lf.replaceAll("\n", "\r\n")),
  });
  assert.equal(fromCrLf, fromLf);
  assert.equal(fromLf.includes("\r"), false);
  assert.match(fromLf, /[^\n]\n$/u);
});

test("freezes top-level and nested binary key order while preserving arrays", () => {
  const rendered = renderCanonicalFrontmatter({
    id: "doc.test",
    type: "test",
    status: "active",
    owner: "tooling",
    summary: "Canonical order.",
    related: ["z", "a"],
    additionalMetadata: {
      zeta: { z: true, a: false },
      alpha: ["z", "a"],
    },
  });
  assert.equal(
    rendered,
    [
      "id: doc.test",
      "type: test",
      "status: active",
      "owner: tooling",
      "summary: Canonical order.",
      "related:",
      "  - a",
      "  - z",
      "alpha:",
      "  - z",
      "  - a",
      "zeta:",
      "  a: false",
      "  z: true",
    ].join("\n"),
  );
});

test("binary-sorts every additional metadata key without consumer vocabulary", () => {
  const rendered = renderCanonicalFrontmatter({
    id: "doc.test",
    type: "test",
    status: "active",
    owner: "tooling",
    summary: "Canonical order.",
    additionalMetadata: {
      aardvark: true,
      code_anchors: [],
      blocked_by: [],
      zebra: true,
    },
  });
  assert.ok(rendered.indexOf("aardvark:") < rendered.indexOf("blocked_by:"));
  assert.ok(rendered.indexOf("blocked_by:") < rendered.indexOf("code_anchors:"));
  assert.ok(rendered.indexOf("code_anchors:") < rendered.indexOf("zebra:"));
});

test("preserves binary order for array-index-like mapping keys", () => {
  const rendered = renderCanonicalFrontmatter({
    id: "doc.test",
    type: "test",
    status: "active",
    owner: "tooling",
    summary: "Numeric-looking keys stay strings.",
    additionalMetadata: {
      "2": "top two",
      "10": "top ten",
      nested: {
        alpha: true,
        "2": "nested two",
        "10": "nested ten",
      },
    },
  });
  assert.equal(
    rendered,
    [
      "id: doc.test",
      "type: test",
      "status: active",
      "owner: tooling",
      "summary: Numeric-looking keys stay strings.",
      '"10": top ten',
      '"2": top two',
      "nested:",
      '  "10": nested ten',
      '  "2": nested two',
      "  alpha: true",
    ].join("\n"),
  );
});

test("roundtrips YAML-sensitive scalars without tags, anchors, or aliases", () => {
  const shared = { text: "same" };
  const rendered = renderCanonicalFrontmatter({
    id: "scalar.test",
    type: "test",
    status: "active",
    owner: "tooling",
    summary: "Scalar coverage.",
    additionalMetadata: {
      values: [
        "null",
        "true",
        "2026-08-13",
        "0123",
        "a: b",
        "# heading",
        "line one\nline two",
        shared,
        shared,
        null,
        0,
      ],
    },
  });
  assert.doesNotMatch(rendered, /(?:^|\s)[&*!][^\s]*/u);
  assert.doesNotMatch(rendered, /^\s*<<:/mu);
  assert.match(rendered, /- "null"/u);
  assert.match(rendered, /- "true"/u);
});

test("rejects reserved, prototype-sensitive, accessor, and cyclic metadata", () => {
  for (const additionalMetadata of [
    { constructor: "bad" },
    { safe: { prototype: "bad" } },
    { __proto__: { polluted: true }, safe: true },
    Object.defineProperty({}, "unsafe", { enumerable: true, get: () => "bad" }),
  ]) {
    assert.throws(
      () => renderCanonicalFrontmatter({ ...frontmatter, additionalMetadata }),
      (error) =>
        error instanceof CanonicalMarkdownError &&
        error.failure === "frontmatter-invalid",
    );
  }
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() =>
    renderCanonicalFrontmatter({
      ...frontmatter,
      additionalMetadata: { cyclic },
    }),
  );
});

test("does not execute array accessors and rejects hidden, symbol, or extra fields", () => {
  let getterCalls = 0;
  const arrayWithGetter = [];
  Object.defineProperty(arrayWithGetter, "0", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return "bad";
    },
  });
  arrayWithGetter.length = 1;
  const symbolMap = { safe: true };
  symbolMap[Symbol("hidden")] = true;
  const hiddenMap = { safe: true };
  Object.defineProperty(hiddenMap, "hidden", { value: true });
  const extraArray = ["safe"];
  extraArray.extra = true;
  for (const value of [arrayWithGetter, symbolMap, hiddenMap, extraArray]) {
    assert.throws(() =>
      renderCanonicalFrontmatter({
        ...frontmatter,
        additionalMetadata: { value },
      }),
    );
  }
  assert.equal(getterCalls, 0);
});

test("reserves every governed Intent/frontmatter key", () => {
  for (const key of [
    "id",
    "type",
    "status",
    "owner",
    "summary",
    "related",
    "slug",
    "destination",
    "title",
  ]) {
    assert.throws(() =>
      renderCanonicalFrontmatter({
        ...frontmatter,
        additionalMetadata: { [key]: "collision" },
      }),
    );
  }
});

test("rejects duplicate related IDs, unsafe numbers, and non-NFC inputs", () => {
  for (const override of [
    { related: ["ADR-0001", "ADR-0001"] },
    { additionalMetadata: { unsafe: Number.MAX_SAFE_INTEGER + 1 } },
    { additionalMetadata: { decimal: 1.5 } },
    { additionalMetadata: { text: "e\u0301" } },
  ]) {
    assert.throws(
      () => renderCanonicalFrontmatter({ ...frontmatter, ...override }),
      (error) =>
        error instanceof CanonicalMarkdownError &&
        error.failure === "frontmatter-invalid",
    );
  }
  assert.throws(
    () => parseGovernedTemplateSkeleton("```markdown\n---\nid: e\u0301\n---\n\n# Title\n```") ,
    (error) =>
      error instanceof CanonicalMarkdownError &&
      error.failure === "template-invalid",
  );
});

test("rejects ambiguous or executable-like template forms without interpolation", async () => {
  const valid = await fixture("adr-template.md");
  for (const source of [
    valid.replace("```markdown", "```md"),
    `${valid}\n\`\`\`markdown\n---\nid: second\n---\n\n# Second\n\`\`\`\n`,
    valid.replace("---\nid: ADR-NNNN", "id: ADR-NNNN"),
    valid.replace("## Context", "# Unexpected second H1"),
    valid.replace("# ADR-NNNN: Decision Title\n\n", "# ADR-NNNN: Decision Title\n"),
    valid.replaceAll("\n", "\r"),
  ]) {
    assert.throws(
      () => parseGovernedTemplateSkeleton(source),
      (error) =>
        error instanceof CanonicalMarkdownError &&
        error.failure === "template-invalid",
    );
  }
  const template = parseGovernedTemplateSkeleton(
    valid.replace("## Context", "## {{ title }} remains literal"),
  );
  assert.match(template.body, /\{\{ title \}\}/u);
});

test("preserves fenced shell comments and Markdown hard-break spaces", async () => {
  const valid = await fixture("adr-template.md");
  const source = valid
    .replace("```markdown", "````markdown")
    .replace(/\n```\n$/u, "\n````\n")
    .replace(
    "What is decided, including ownership and invariants?",
    "```sh\n# comment inside code, not an H1\n```\n\nHard break here  ",
  );
  const template = parseGovernedTemplateSkeleton(source);
  assert.match(template.body, /# comment inside code, not an H1/u);
  assert.match(template.body, /Hard break here  $/u);
  const rendered = renderCanonicalDocument({
    frontmatter,
    heading: "ADR-9001: Frozen ADR",
    template,
  });
  assert.match(rendered, /Hard break here  \n$/u);
  assert.throws(() =>
    parseGovernedTemplateSkeleton(
      valid.replace("## Decision", "# Actual second H1"),
    ),
  );
});

test("rejects unsafe placeholder YAML even though it is discarded", async () => {
  const valid = await fixture("adr-template.md");
  for (const replacement of [
    "id: ADR-NNNN\nconstructor: unsafe",
    "id: ADR-NNNN\nunsafe: .inf",
    "id: ADR-NNNN\nunsafe: 1.5",
  ]) {
    assert.throws(() =>
      parseGovernedTemplateSkeleton(valid.replace("id: ADR-NNNN", replacement)),
    );
  }
});

test("bounds template bytes before parsing", () => {
  assert.throws(
    () => parseGovernedTemplateSkeleton("x".repeat(256 * 1024 + 1)),
    (error) =>
      error instanceof CanonicalMarkdownError &&
      error.failure === "template-limit-exceeded",
  );
});
