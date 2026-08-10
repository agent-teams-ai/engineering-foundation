import { parseTree, type Node, type ParseError } from "jsonc-parser";

export type StrictJsonFailure = "duplicate-key" | "syntax";

export class StrictJsonError extends Error {
  readonly failure: StrictJsonFailure;

  constructor(failure: StrictJsonFailure) {
    super(`Strict JSON parsing failed: ${failure}.`);
    this.name = "StrictJsonError";
    this.failure = failure;
  }
}

function assertUniqueObjectKeys(node: Node): void {
  if (node.type === "object") {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value as unknown;
      if (typeof key !== "string" || keys.has(key)) {
        throw new StrictJsonError("duplicate-key");
      }
      keys.add(key);
    }
  }
  for (const child of node.children ?? []) {
    assertUniqueObjectKeys(child);
  }
}

export function parseStrictJson(source: string): unknown {
  const errors: ParseError[] = [];
  const root = parseTree(source, errors, {
    allowEmptyContent: false,
    allowTrailingComma: false,
    disallowComments: true
  });
  if (root === undefined || errors.length > 0) {
    throw new StrictJsonError("syntax");
  }
  assertUniqueObjectKeys(root);
  // jsonc-parser's AST values use null-prototype objects. Materialize the
  // already-proven strict source with the platform JSON value shape expected by
  // existing schema and config consumers.
  return JSON.parse(source) as unknown;
}
