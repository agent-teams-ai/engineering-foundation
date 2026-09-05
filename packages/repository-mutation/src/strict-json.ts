export type StrictJsonFailure = "duplicate-key" | "syntax";

export class StrictJsonError extends Error {
  readonly failure: StrictJsonFailure;

  constructor(failure: StrictJsonFailure) {
    super(`Strict JSON parsing failed: ${failure}.`);
    this.name = "StrictJsonError";
    this.failure = failure;
  }
}

class JsonCursor {
  #offset = 0;
  readonly #source: string;

  constructor(source: string) {
    this.#source = source;
  }

  get done(): boolean {
    this.#space();
    return this.#offset === this.#source.length;
  }

  #space(): void {
    while (/\s/u.test(this.#source[this.#offset] ?? "")) {this.#offset += 1;}
  }

  #take(expected: string): void {
    this.#space();
    if (!this.#source.startsWith(expected, this.#offset)) {throw new StrictJsonError("syntax");}
    this.#offset += expected.length;
  }

  #string(): string {
    this.#space();
    const start = this.#offset;
    if (this.#source[this.#offset] !== '"') {throw new StrictJsonError("syntax");}
    this.#offset += 1;
    while (this.#offset < this.#source.length) {
      const character = this.#source[this.#offset];
      if (character === '"') {
        this.#offset += 1;
        try {
          return JSON.parse(this.#source.slice(start, this.#offset)) as string;
        } catch {
          throw new StrictJsonError("syntax");
        }
      }
      if (character === "\\") {this.#offset += 1;}
      this.#offset += 1;
    }
    throw new StrictJsonError("syntax");
  }

  value(): void {
    this.#space();
    const character = this.#source[this.#offset];
    if (character === "{") { this.#object(); return; }
    if (character === "[") { this.#array(); return; }
    if (character === '"') { this.#string(); return; }
    const remainder = this.#source.slice(this.#offset);
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(remainder)?.[0];
    if (token === undefined) {throw new StrictJsonError("syntax");}
    this.#offset += token.length;
  }

  #array(): void {
    this.#take("[");
    this.#space();
    if (this.#source[this.#offset] === "]") { this.#offset += 1; return; }
    for (;;) {
      this.value();
      this.#space();
      if (this.#source[this.#offset] === "]") { this.#offset += 1; return; }
      this.#take(",");
    }
  }

  #object(): void {
    this.#take("{");
    const keys = new Set<string>();
    this.#space();
    if (this.#source[this.#offset] === "}") { this.#offset += 1; return; }
    for (;;) {
      const key = this.#string();
      if (keys.has(key)) {throw new StrictJsonError("duplicate-key");}
      keys.add(key);
      this.#take(":");
      this.value();
      this.#space();
      if (this.#source[this.#offset] === "}") { this.#offset += 1; return; }
      this.#take(",");
    }
  }
}

export function parseStrictJson(source: string): unknown {
  const cursor = new JsonCursor(source);
  cursor.value();
  if (!cursor.done) {throw new StrictJsonError("syntax");}
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new StrictJsonError("syntax");
  }
}
