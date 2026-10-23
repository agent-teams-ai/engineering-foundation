import assert from "node:assert/strict";
import test from "node:test";
import type {
  PublicApiItem,
  PublicApiSnapshot,
} from "../src/capabilities/public-api-compatibility/application/model/public-api.js";

export function registerNativeSpellingCases(
  aliasSnapshot: (signature: string, metadata?: Partial<PublicApiItem>) => PublicApiSnapshot,
  compareAlias: (
    before: PublicApiSnapshot,
    after: PublicApiSnapshot,
  ) => { readonly classification: string },
): void {
  test("property type parentheses preserve the retained GrowthCoverage indexed query without admitting binding changes", () => {
    const metadata = {
      kind: "PropertySignature",
      parentKind: "Interface",
      parentReference: "syntax-fixture!Coverage:interface",
    };
    const before = aliasSnapshot("readonly dimension: typeof growthDimensions[number];", metadata);
    const after = aliasSnapshot("readonly dimension: (typeof growthDimensions)[number];", metadata);
    assert.equal(compareAlias(before, after).classification, "none");
    assert.equal(compareAlias(after, before).classification, "none");
    for (const signature of [
      "readonly dimension: (typeof otherDimensions)[number];",
      "dimension: (typeof growthDimensions)[number];",
      "readonly dimension?: (typeof growthDimensions)[number];",
      "readonly dimension: (string | number)[];",
    ]) {
      const changed = aliasSnapshot(signature, metadata);
      assert.equal(compareAlias(before, changed).classification, "breaking");
      assert.equal(compareAlias(changed, before).classification, "breaking");
    }
  });

  test("literal spelling proof preserves exact restoration excerpts and rejects changed values or declarations", () => {
    const metadata = {
      kind: "PropertySignature",
      parentKind: "Interface",
      parentReference: "syntax-fixture!Result:interface",
    };
    const before = aliasSnapshot("readonly code: 'input' | 'mismatch';", metadata);
    const after = aliasSnapshot('readonly code: "input" | "mismatch";', metadata);
    assert.equal(compareAlias(before, after).classification, "none");
    assert.equal(compareAlias(after, before).classification, "none");
    const aliasBefore = aliasSnapshot(
      "export type Alias = { code: 'conformant'; digest: `sha256:${string}`; };",
    );
    const aliasAfter = aliasSnapshot(
      'export type Alias = { code: "conformant"; digest: `sha256:${string}`; };',
    );
    assert.equal(compareAlias(aliasBefore, aliasAfter).classification, "none");
    assert.equal(compareAlias(aliasAfter, aliasBefore).classification, "none");
    for (const signature of [
      'readonly code: "other" | "mismatch";',
      'code: "input" | "mismatch";',
      'readonly code?: "input" | "mismatch";',
      'readonly code: "input" | "mismatch"; extra: string;',
    ]) {
      const changed = aliasSnapshot(signature, metadata);
      assert.equal(compareAlias(before, changed).classification, "breaking");
      assert.equal(compareAlias(changed, before).classification, "breaking");
    }
  });

  test("literal spelling proof preserves retained constant and function type excerpts", () => {
    for (const [kind, beforeText, afterText] of [
      [
        "Variable",
        "export declare const STANDARD: { readonly version: 'v1.1'; };",
        'export declare const STANDARD: { readonly version: "v1.1"; };',
      ],
      [
        "Function",
        "export declare function layout(): Pick<Input, 'featureRoots' | 'roleRoots'>;",
        'export declare function layout(): Pick<Input, "featureRoots" | "roleRoots">;',
      ],
    ] as const) {
      const before = aliasSnapshot(beforeText, { kind });
      const after = aliasSnapshot(afterText, { kind });
      assert.equal(compareAlias(before, after).classification, "none");
      assert.equal(compareAlias(after, before).classification, "none");
      const changed = aliasSnapshot(
        afterText.replace(kind === "Variable" ? "v1.1" : "roleRoots", "changed"),
        { kind },
      );
      assert.equal(compareAlias(before, changed).classification, "breaking");
      assert.equal(compareAlias(changed, before).classification, "breaking");
    }
  });
}
