function malformed(reason: "syntax" | "duplicate-key"): never {
  throw new TypeError(`SDK growth authority response is invalid strict JSON: ${reason}.`);
}

/** Validate duplicate-key and grammar invariants before JSON.parse erases the
 * original token stream. JSON.parse then creates ordinary data objects without
 * carrying accessors or Proxy behavior across the transport boundary. */
export function parseStrictJsonResponse(source: string): unknown {
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
  const value = (): void => {
    space();
    const character = source[offset];
    if (character === "{") { object(); return; }
    if (character === "[") { array(); return; }
    if (character === '"') { string(); return; }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(source.slice(offset))?.[0];
    if (token === undefined) { malformed("syntax"); }
    offset += token.length;
  };
  const array = (): void => {
    take("["); space();
    if (source[offset] === "]") { offset += 1; return; }
    for (;;) { value(); space(); if (source[offset] === "]") { offset += 1; return; } take(","); }
  };
  const object = (): void => {
    take("{");
    const keys = new Set<string>();
    space();
    if (source[offset] === "}") { offset += 1; return; }
    for (;;) {
      const key = string();
      if (keys.has(key)) { malformed("duplicate-key"); }
      keys.add(key); take(":"); value(); space();
      if (source[offset] === "}") { offset += 1; return; }
      take(",");
    }
  };
  value(); space();
  if (offset !== source.length) { malformed("syntax"); }
  try { return JSON.parse(source) as unknown; }
  catch { return malformed("syntax"); }
}
