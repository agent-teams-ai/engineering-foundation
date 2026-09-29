function malformed(reason: "syntax" | "duplicate-key" | "depth"): never {
  throw new TypeError(`SDK growth authority response is invalid strict JSON: ${reason}.`);
}

/** Validate duplicate-key and grammar invariants before JSON.parse erases the
 * original token stream. JSON.parse then creates ordinary data objects without
 * carrying accessors or Proxy behavior across the transport boundary. */
export function parseStrictJsonResponse(source: string, maximumDepth?: number): unknown {
  let offset = 0;
  const space = (): void => { while (/\s/u.test(source[offset] ?? "")) { offset += 1; } };
  const take = (expected: string): void => {
    space();
    if (!source.startsWith(expected, offset)) { malformed("syntax"); }
    offset += expected.length;
  };
  const string = (): string => {
    space();
    const start = offset;
    if (source[offset] !== '"') { return malformed("syntax"); }
    offset += 1;
    while (offset < source.length) {
      const character = source[offset];
      if (character === '"') {
        offset += 1;
        try { return JSON.parse(source.slice(start, offset)) as string; }
        catch { return malformed("syntax"); }
      }
      if (character === "\\") { offset += 1; }
      offset += 1;
    }
    return malformed("syntax");
  };
  const value = (depth: number): void => {
    if (maximumDepth !== undefined && depth > maximumDepth) { malformed("depth"); }
    space();
    const character = source[offset];
    if (character === "{") { object(depth); return; }
    if (character === "[") { array(depth); return; }
    if (character === '"') { string(); return; }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(source.slice(offset))?.[0];
    if (token === undefined) { malformed("syntax"); }
    offset += token.length;
  };
  const array = (depth: number): void => {
    take("["); space();
    if (source[offset] === "]") { offset += 1; return; }
    for (;;) { value(depth + 1); space(); if (source[offset] === "]") { offset += 1; return; } take(","); }
  };
  const object = (depth: number): void => {
    take("{");
    const keys = new Set<string>();
    space();
    if (source[offset] === "}") { offset += 1; return; }
    for (;;) {
      const key = string();
      if (keys.has(key)) { malformed("duplicate-key"); }
      keys.add(key); take(":"); value(depth + 1); space();
      if (source[offset] === "}") { offset += 1; return; }
      take(",");
    }
  };
  value(0); space();
  if (offset !== source.length) { malformed("syntax"); }
  try { return JSON.parse(source) as unknown; }
  catch { return malformed("syntax"); }
}
