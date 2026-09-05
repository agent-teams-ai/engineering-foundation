import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";

interface ValidationIssue {
  readonly message: string;
  readonly path?: readonly PropertyKey[];
}

type Validator<Output> = (value: unknown) =>
  | Readonly<{ readonly value: Output }>
  | Readonly<{ readonly issues: readonly ValidationIssue[] }>;

export function standardJsonSchema<Output>(
  jsonSchema: Readonly<Record<string, unknown>>,
  validate: Validator<Output>
): StandardSchemaWithJSON<unknown, Output> {
  return Object.freeze({
    "~standard": Object.freeze({
      version: 1 as const,
      vendor: "agent-teams.docs-protocol-mcp",
      validate,
      jsonSchema: Object.freeze({
        input: () => jsonSchema,
        output: () => jsonSchema
      })
    })
  });
}

export function recordOrIssue(value: unknown):
  | Readonly<{ readonly record: Readonly<Record<string, unknown>> }>
  | Readonly<{ readonly issues: readonly ValidationIssue[] }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Object.freeze({ issues: Object.freeze([{ message: "Expected an object." }]) });
  }
  return Object.freeze({ record: value as Readonly<Record<string, unknown>> });
}

export function unknownKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>
): readonly ValidationIssue[] {
  return Object.freeze(Object.keys(record)
    .filter((key) => !allowed.has(key))
    .toSorted()
    .map((key) => Object.freeze({ message: "Unknown property.", path: Object.freeze([key]) })));
}

export function objectRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : Object.freeze({});
}
