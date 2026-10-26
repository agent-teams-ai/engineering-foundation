export class ConsumerCliInputError extends Error {
  readonly code = "DOCS_CONSUMER_CLI_INVALID";
}

export const COHORT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
export const SHA256 = /^sha256:[0-9a-f]{64}$/u;
export const GIT_SHA = /^(?!0{40}$)[0-9a-f]{40}$/u;
export const MAXIMUM_ARGUMENT_LENGTH = 4096;
export const MAXIMUM_ARGUMENTS = 32;

export class Arguments {
  readonly #values: string[];
  readonly #used = new Set<number>();

  public constructor(values: readonly string[]) {
    this.#values = [...values];
  }

  public flag(name: string): boolean {
    const indexes = this.#values.flatMap((value, index) => (value === name ? [index] : []));
    if (indexes.length > 1) {
      throw new ConsumerCliInputError(`${name} may be supplied only once.`);
    }
    if (indexes[0] !== undefined) {
      this.#used.add(indexes[0]);
    }
    return indexes.length === 1;
  }

  public one(name: string, required = false): string | undefined {
    const indexes = this.#values.flatMap((value, index) => (value === name ? [index] : []));
    if (indexes.length > 1) {
      throw new ConsumerCliInputError(`${name} may be supplied only once.`);
    }
    const index = indexes[0];
    if (index === undefined) {
      if (required) {
        throw new ConsumerCliInputError(`${name} is required.`);
      }
      return undefined;
    }
    const value = this.#values[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ConsumerCliInputError(`${name} requires a value.`);
    }
    if (value.length > MAXIMUM_ARGUMENT_LENGTH || value.includes("\u0000")) {
      throw new ConsumerCliInputError(`${name} contains an invalid or overlong value.`);
    }
    this.#used.add(index);
    this.#used.add(index + 1);
    return value;
  }

  public assertConsumed(): void {
    const unknown = this.#values.filter((_value, index) => !this.#used.has(index));
    if (unknown.length > 0) {
      throw new ConsumerCliInputError(`Unknown consumer arguments: ${unknown.join(" ")}.`);
    }
  }
}
