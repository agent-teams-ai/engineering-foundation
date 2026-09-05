import type { CallExpression, Expression, Program } from "oxc-parser";

import { LoaderLexicalScopes } from "./loader-lexical-scopes.js";
import {
  builtinOrigin, memberOrigin, propertyName, unwrapExpression,
  type LexicalBinding, type LexicalScope, type LoaderOrigin
} from "./loader-syntax.js";

function isImportMetaUrl(expression: Expression): boolean {
  const value = unwrapExpression(expression);
  return value.type === "MemberExpression" &&
    propertyName(value.property, value.computed) === "url" &&
    value.object.type === "MetaProperty" &&
    value.object.meta.name === "import" && value.object.property.name === "meta";
}

function opaqueOrigins(origins: readonly LoaderOrigin[]): readonly LoaderOrigin[] {
  return origins.map((origin) => ({ ...origin, opaque: true }));
}

function originKey(origin: LoaderOrigin): string {
  return `${origin.kind}:${origin.opaque === true}`;
}

/** Finite provenance analysis, not an interpreter or flow-sensitive points-to analysis. */
export class LoaderBindingAnalysis {
  readonly #scopes: LoaderLexicalScopes;
  readonly #origins = new WeakMap<LexicalBinding, readonly LoaderOrigin[]>();
  readonly #dependents = new WeakMap<LexicalBinding, Set<LexicalBinding>>();
  readonly #pending = new Set<LexicalBinding>();
  #current: LexicalBinding | undefined;

  constructor(program: Program) {
    this.#scopes = new LoaderLexicalScopes(program);
  }

  callOrigins(call: CallExpression): readonly LoaderOrigin[] {
    return this.#expressionOrigins(call.callee, this.#scopes.scope(call));
  }

  #bindingOrigins(binding: LexicalBinding): readonly LoaderOrigin[] {
    if (this.#current !== undefined) {
      const dependents = this.#dependents.get(binding) ?? new Set<LexicalBinding>();
      dependents.add(this.#current);
      this.#dependents.set(binding, dependents);
    }
    if (!this.#origins.has(binding)) {
      this.#origins.set(binding, []);
      this.#refreshBinding(binding);
    }
    if (this.#current === undefined) {
      // Each kind/opacity pair can be added only once. Cycles converge without
      // discarding evidence or repeatedly enumerating paths through alias graphs.
      for (const pending of this.#pending) {
        this.#pending.delete(pending);
        this.#refreshBinding(pending);
      }
    }
    return this.#origins.get(binding) ?? [];
  }

  #refreshBinding(binding: LexicalBinding): void {
    const previous = this.#current;
    this.#current = binding;
    const origins = binding.declaredOrigin === undefined ? [] : [binding.declaredOrigin];
    for (const input of binding.inputs) {
      let candidates = this.#expressionOrigins(input.expression, this.#scopes.scope(input.expression));
      for (const property of input.properties) {
        candidates = candidates.flatMap((candidate) => memberOrigin(candidate, property) ?? []);
      }
      origins.push(...candidates);
    }
    this.#current = previous;
    // Keep every possible loader kind after writes; selecting the last one can hide a load.
    const result = binding.mutable ? opaqueOrigins(origins) : origins;
    const unique = new Map(result.map((origin) => [originKey(origin), origin]));
    const known = this.#origins.get(binding) ?? [];
    if (unique.size !== known.length || known.some((origin) => !unique.has(originKey(origin)))) {
      this.#origins.set(binding, [...unique.values()]);
      for (const dependent of this.#dependents.get(binding) ?? []) {
        this.#pending.add(dependent);
      }
    }
  }

  #expressionOrigins(value: Expression, scope: LexicalScope): readonly LoaderOrigin[] {
    const expression = unwrapExpression(value);
    if (expression.type === "Identifier") {
      const binding = this.#scopes.resolve(expression.name, scope);
      return binding === undefined ? [] : this.#bindingOrigins(binding);
    }
    if (expression.type === "MemberExpression") {
      return this.#expressionOrigins(expression.object, scope).flatMap((object) =>
        memberOrigin(object, propertyName(expression.property, expression.computed)) ?? []);
    }
    if (expression.type === "ConditionalExpression" || expression.type === "LogicalExpression") {
      const branches = expression.type === "ConditionalExpression"
        ? [expression.consequent, expression.alternate] : [expression.left, expression.right];
      return opaqueOrigins(branches.flatMap((branch) => this.#expressionOrigins(branch, scope)));
    }
    if (expression.type === "SequenceExpression") {
      const last = expression.expressions.at(-1);
      return last === undefined ? [] : this.#expressionOrigins(last, scope);
    }
    return expression.type === "CallExpression"
      ? this.#expressionOrigins(expression.callee, scope).flatMap((callee) =>
          this.#callResultOrigin(expression, callee) ?? []) : [];
  }

  #callResultOrigin(expression: CallExpression, callee: LoaderOrigin): LoaderOrigin | undefined {
    const argument = expression.arguments[0];
    if (callee.kind === "bound-loader-factory") {
      return { kind: "loader", opaque: true };
    }
    if (callee.kind === "factory") {
      return { kind: "loader", ...(callee.opaque === true || argument === undefined ||
        argument.type === "SpreadElement" || !isImportMetaUrl(argument) ? { opaque: true } : {}) };
    }
    if (callee.kind !== "loader" && callee.kind !== "builtin-getter") {
      return undefined;
    }
    if (argument?.type !== "Literal" || typeof argument.value !== "string") {
      return undefined;
    }
    const origin = builtinOrigin(argument.value);
    return origin === undefined ? undefined : { ...origin, ...(callee.opaque === true ? { opaque: true } : {}) };
  }
}
