import assert from "node:assert/strict";
import { parse } from "yaml";
interface BoundaryFixture {
  id: string;
  roots: string[];
  entrypoints: string[];
  allow: { boundaries: string[]; builtins: string[]; packages: string[] };
}
function strings(value: unknown): string[] {
  assert.ok(Array.isArray(value));
  return value.map((entry: unknown) => {
    assert.equal(typeof entry, "string");
    if (typeof entry !== "string") {
      throw new Error("Invalid boundary fixture string");
    }
    return entry;
  });
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
export function parseBoundaryFixture(source: string): { boundaries: BoundaryFixture[] } {
  const parsed = record(parse(source));
  assert.ok(Array.isArray(parsed.boundaries));
  return {
    boundaries: parsed.boundaries.map((entry: unknown) => {
      const boundary = record(entry);
      const allow = record(boundary.allow);
      assert.equal(typeof boundary.id, "string");
      if (typeof boundary.id !== "string") {
        throw new Error("Invalid boundary fixture ID");
      }
      return {
        ...boundary,
        id: boundary.id,
        roots: strings(boundary.roots),
        entrypoints: strings(boundary.entrypoints),
        allow: {
          ...allow,
          boundaries: strings(allow.boundaries),
          builtins: strings(allow.builtins),
          packages: strings(allow.packages),
        },
      };
    }),
  };
}
