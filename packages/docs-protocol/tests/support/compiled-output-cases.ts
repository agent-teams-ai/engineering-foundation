import assert from "node:assert/strict";
import test from "node:test";
import { YamlCompiledOutputReader } from "../../dist/features/portable-documentation/adapters/outbound/yaml-compiled-output-reader.js";

const output = (content: string) => ({
  contentBase64: Buffer.from(content).toString("base64"),
  digest: `sha256:${"8".repeat(64)}` as const,
  mediaType: "text/markdown; charset=utf-8" as const,
  size: Buffer.byteLength(content),
});

export function registerCompiledOutputCases(): void {
  void test("compiled output parser and pure projection preserve canonical bytes and diagnostics", async () => {
    const { compiledDocument } =
      await import("../../dist/features/portable-documentation/application/compiled-document.js");
    const reader = new YamlCompiledOutputReader();
    const input = {
      anchors: [{ enforcement: "required" as const, pattern: "src/*.ts" }],
      blockedBy: ["TASK-1"],
      related: ["TASK-1"],
    };
    const content = "---\nid: ADR-1\ncustom: {list: [one, 2, true]}\n---\n# Body\n";
    const bytes = output(content);
    const projected = compiledDocument(bytes, reader.read(bytes), input);
    assert.deepEqual(projected, {
      schemaVersion: 1,
      document: { content, digest: bytes.digest, mediaType: bytes.mediaType, size: bytes.size },
      frontmatter: "id: ADR-1\ncustom: {list: [one, 2, true]}",
      metadata: { id: "ADR-1", custom: { list: ["one", 2, true] } },
      anchors: input.anchors,
      relations: { blockedBy: input.blockedBy, related: input.related },
    });
    const cases: readonly (readonly [string, string, string])[] = [
      ["missing", "DocsProfileError", "Compiled document does not contain canonical frontmatter."],
      [
        "---\nid: [\n---\nbody",
        "DocsProfileError",
        "Compiled document frontmatter is not valid duplicate-free YAML.",
      ],
      [
        "---\nid: first\nid: second\n---\nbody",
        "DocsProfileError",
        "Compiled document frontmatter is not valid duplicate-free YAML.",
      ],
      ["---\nx: &x one\ny: *x\n---\nbody", "ReferenceError", "Alias resolution is disabled"],
      [
        "---\n- a\n---\nbody",
        "DocsProfileError",
        "Compiled document frontmatter must be one metadata mapping.",
      ],
    ];
    for (const [source, name, message] of cases) {
      assert.throws(() => reader.read(output(source)), { name, message });
    }
    const incomplete = { ...bytes, size: undefined };
    const decode = reader.read.bind(reader);
    assert.throws(() => Reflect.apply(decode, undefined, [incomplete]), {
      name: "DocsProfileError",
      message: "Document Plan does not contain one complete compiled output.",
    });
    assert.throws(
      () =>
        compiledDocument(
          bytes,
          { content, frontmatter: "", metadata: { value: "x".repeat(1_048_577) } },
          input,
        ),
      /1 MiB JSON budget/u,
    );
    assert.throws(
      () => compiledDocument(bytes, { content, frontmatter: "", metadata: { value: -0 } }, input),
      /safe integers/u,
    );
  });
}
