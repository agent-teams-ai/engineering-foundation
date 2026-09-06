type SchemaContributions = readonly [readonly [string, ...string[]], ...(readonly string[])[]];

type ConcatenatedSchemaIds<Groups extends readonly (readonly string[])[]> =
  Groups extends readonly [infer Head extends readonly string[], ...infer Tail extends readonly (readonly string[])[]]
    ? readonly [...Head, ...ConcatenatedSchemaIds<Tail>]
    : readonly [];

export function createSchemaList<const Groups extends SchemaContributions>(groups: Groups): {
  readonly schemaIds: ConcatenatedSchemaIds<Groups>;
  readonly firstSchemaId: Groups[number][number];
} {
  return {
    // Array.flat preserves contribution order and duplicates; readonly is type-only.
    schemaIds: groups.flat() as unknown as ConcatenatedSchemaIds<Groups>,
    // An actual member carries the union type into assembly's inert typeof alias.
    firstSchemaId: groups[0][0]
  };
}
