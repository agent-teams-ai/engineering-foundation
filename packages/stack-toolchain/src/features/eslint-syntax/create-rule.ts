import type { RulesMeta } from "@eslint/core";
import type { RuleContext, RuleDocs, RuleListener, SyntaxRule } from "./rule-contract.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Retains typescript-eslint 8.59.1 applyDefault/deepMerge semantics (MIT). */
function mergeRecords(first: Record<string, unknown>, second: Record<string, unknown>): Record<string, unknown> {
  const keys = new Set([...Object.keys(first), ...Object.keys(second)]);
  return Object.fromEntries([...keys].map((key) => {
    const left = first[key];
    const right = second[key];
    const value = key in first && key in second
      ? isRecord(left) && isRecord(right) ? mergeRecords(left, right) : right
      : key in first ? left : right;
    return [key, value];
  }));
}

/** The validated option tuple retains its length and element positions. */
export function applyDefault<Options extends readonly unknown[]>(defaults: Readonly<Options>, supplied: readonly unknown[]): Options {
  type Mutable = { -readonly [Index in keyof Options]: Options[Index] };
  const result = structuredClone(defaults) as Mutable;
  for (let index = 0; index < result.length; index += 1) {
    const incoming = supplied[index];
    const fallback = result[index];
    if (incoming !== undefined) {
      // ESLint validates options against each retained rule schema before create.
      // The only assertion is the mutable view of this fresh, same-shape clone.
      result[index] = isRecord(fallback) && isRecord(incoming)
        ? mergeRecords(fallback, incoming)
        : incoming;
    }
  }
  return result;
}

export function createRule<Options extends readonly unknown[], MessageIds extends string>(definition: {
  name: string;
  meta: RulesMeta<MessageIds, [...Options], RuleDocs>;
  defaultOptions: Readonly<Options>;
  create(context: RuleContext<MessageIds, Options>, options: Readonly<Options>): RuleListener;
}): SyntaxRule<Options, MessageIds> {
  const defaults = definition.meta.defaultOptions ?? definition.defaultOptions;
  return {
    name: definition.name,
    defaultOptions: definition.defaultOptions,
    meta: {
      ...definition.meta,
      docs: {
        ...definition.meta.docs,
        url: `https://typescript-eslint.io/rules/${definition.name}`,
      },
    },
    create(context) {
      return definition.create(context, applyDefault(defaults, context.options));
    },
  };
}
