export type StrictJsonFailure = "duplicate-key" | "syntax";

export class StrictJsonError extends Error {
  readonly failure: StrictJsonFailure;

  constructor(failure: StrictJsonFailure) {
    super(`Strict JSON parsing failed: ${failure}.`);
    this.name = "StrictJsonError";
    this.failure = failure;
  }
}

function validateStrictJsonSource(source: string): void {
  let offset = 0;

  function space(): void {
    while (/\s/u.test(source[offset] ?? "")) {offset += 1;}
  }

  function take(expected: string): void {
    space();
    if (!source.startsWith(expected, offset)) {throw new StrictJsonError("syntax");}
    offset += expected.length;
  }

  function string(): string {
    space();
    const start = offset;
    if (source[offset] !== '"') {throw new StrictJsonError("syntax");}
    offset += 1;
    while (offset < source.length) {
      const character = source[offset];
      if (character === '"') {
        offset += 1;
        try {
          return JSON.parse(source.slice(start, offset)) as string;
        } catch {
          throw new StrictJsonError("syntax");
        }
      }
      if (character === "\\") {offset += 1;}
      offset += 1;
    }
    throw new StrictJsonError("syntax");
  }

  function value(): void {
    space();
    const character = source[offset];
    if (character === "{") { object(); return; }
    if (character === "[") { array(); return; }
    if (character === '"') { string(); return; }
    const remainder = source.slice(offset);
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(remainder)?.[0];
    if (token === undefined) {throw new StrictJsonError("syntax");}
    offset += token.length;
  }

  function array(): void {
    take("[");
    space();
    if (source[offset] === "]") { offset += 1; return; }
    for (;;) {
      value();
      space();
      if (source[offset] === "]") { offset += 1; return; }
      take(",");
    }
  }

  function object(): void {
    take("{");
    const keys = new Set<string>();
    space();
    if (source[offset] === "}") { offset += 1; return; }
    for (;;) {
      const key = string();
      if (keys.has(key)) {throw new StrictJsonError("duplicate-key");}
      keys.add(key);
      take(":");
      value();
      space();
      if (source[offset] === "}") { offset += 1; return; }
      take(",");
    }
  }

  value();
  space();
  if (offset !== source.length) {throw new StrictJsonError("syntax");}
}

export function parseStrictJson(source: string): unknown {
  validateStrictJsonSource(source);
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new StrictJsonError("syntax");
  }
}
