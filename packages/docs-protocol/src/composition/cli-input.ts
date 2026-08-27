export class CliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliInputError";
  }
}

export class Arguments {
  readonly #values: string[];
  readonly #used = new Set<number>();

  constructor(values: readonly string[]) {
    const separator = values.indexOf("--");
    this.#values = separator === -1
      ? [...values]
      : [...values.slice(0, separator), ...values.slice(separator + 1)];
  }

  flag(name: string): boolean {
    const indexes = this.#values.flatMap((value, index) => value === name ? [index] : []);
    if (indexes.length > 1) {throw new CliInputError(`${name} may be supplied only once.`);}
    if (indexes[0] !== undefined) {this.#used.add(indexes[0]);}
    return indexes.length === 1;
  }

  one(name: string, required = false): string | undefined {
    const indexes = this.#values.flatMap((value, index) => value === name ? [index] : []);
    if (indexes.length > 1) {throw new CliInputError(`${name} may be supplied only once.`);}
    const index = indexes[0];
    if (index === undefined) {
      if (required) {throw new CliInputError(`${name} is required.`);}
      return undefined;
    }
    const value = this.#values[index + 1];
    if (value === undefined || value.startsWith("--")) {throw new CliInputError(`${name} requires a value.`);}
    this.#used.add(index);
    this.#used.add(index + 1);
    return value;
  }

  many(name: string): readonly string[] {
    const results: string[] = [];
    for (let index = 0; index < this.#values.length; index += 1) {
      if (this.#values[index] !== name) {continue;}
      const value = this.#values[index + 1];
      if (value === undefined || value.startsWith("--")) {throw new CliInputError(`${name} requires a value.`);}
      this.#used.add(index);
      this.#used.add(index + 1);
      results.push(value);
    }
    return Object.freeze(results);
  }

  positionals(): readonly string[] {
    return Object.freeze(this.#values.filter((_value, index) => !this.#used.has(index)));
  }
}
