import { Visitor, type BindingPattern, type Expression, type Node, type Program } from "oxc-parser";

import {
  builtinOrigin, childNodes, hasRuntimeModuleSyntax, memberOrigin, patternBindings, propertyName, unwrapExpression,
  type BindingInput, type LexicalBinding, type LexicalScope, type LoaderOrigin
} from "./loader-syntax.js";

/** Collect declarations before observing calls: lexical shadowing includes hoisting and TDZ. */
export class LoaderLexicalScopes {
  readonly #nodeScopes = new WeakMap<Node, LexicalScope>();
  readonly #program: LexicalScope = { bindings: new Map(), kind: "program" };

  constructor(program: Program, path: string) {
    for (const [name, kind] of [
      ["require", "loader"], ["module", "commonjs-module"], ["process", "process"]
    ] as const) {
      this.#program.bindings.set(name, { declaredOrigin: { kind }, inputs: [], mutable: false });
    }
    // Only CommonJS wrapper parameters survive source-level var redeclarations.
    // Script syntax alone cannot decide the package's execution mode.
    const varInitialBindings = new Map<string, LexicalBinding>();
    const possibleWrapper = program.sourceType !== "module" ||
      (!/\.m[jt]s$/u.test(path) && !hasRuntimeModuleSyntax(program));
    if (possibleWrapper && !/\.d\.[cm]?ts$/u.test(path)) {
      for (const name of ["require", "module"]) {
        const origin = this.#program.bindings.get(name)?.declaredOrigin;
        if (origin !== undefined) {
          varInitialBindings.set(name, { inputs: [], mutable: false,
            declaredOrigin: { ...origin, ...(program.sourceType === "commonjs" ? {} : { opaque: true }) } });
        }
      }
    }
    this.#collect(program, { ...this.#childScope(this.#program, "program"), varInitialBindings });
    this.#markMutations(program);
  }

  scope(node: Node): LexicalScope {
    return this.#nodeScopes.get(node) ?? this.#program;
  }

  resolve(name: string, scope: LexicalScope): LexicalBinding | undefined {
    for (let current: LexicalScope | undefined = scope; current !== undefined; current = current.parent) {
      const binding = current.bindings.get(name);
      if (binding !== undefined) {
        return binding;
      }
    }
    return undefined;
  }

  #childScope(parent: LexicalScope, kind: LexicalScope["kind"]): LexicalScope {
    return { bindings: new Map(), kind, parent };
  }

  #declare(scope: LexicalScope, name: string, input?: BindingInput, origin?: LoaderOrigin): void {
    const previous = scope.bindings.get(name);
    if (previous !== undefined) {
      if (input !== undefined) {
        previous.mutable = true;
        previous.inputs.push(input);
      }
      return;
    }
    scope.bindings.set(name, {
      inputs: input === undefined ? [] : [input],
      ...(origin === undefined ? {} : { declaredOrigin: origin }),
      mutable: false
    });
  }

  #declarePattern(scope: LexicalScope, pattern: BindingPattern, expression?: Expression): void {
    for (const { name, properties, defaults } of patternBindings(pattern)) {
      this.#declare(scope, name, expression === undefined ? undefined : { expression, properties });
      for (const input of defaults) {
        this.#declare(scope, name, input);
      }
    }
  }

  #varScope(scope: LexicalScope): LexicalScope {
    let current = scope;
    while (current.kind === "block" && current.parent !== undefined) {
      current = current.parent;
    }
    return current;
  }

  #declareVar(scope: LexicalScope, pattern: BindingPattern): void {
    for (const { name } of patternBindings(pattern)) {
      const initialBinding = scope.varInitialBindings?.get(name);
      if (initialBinding !== undefined && !scope.bindings.has(name)) {
        // The body receives the parameter's value, not its binding identity.
        // Body writes cannot change closures evaluated in parameter defaults.
        scope.bindings.set(name, { inputs: [], mutable: false, initialBinding });
      }
    }
  }

  #collectFunction(node: Extract<Node, {
    type: "FunctionDeclaration" | "FunctionExpression" | "TSDeclareFunction" |
      "TSEmptyBodyFunctionExpression" | "ArrowFunctionExpression"
  }>, scope: LexicalScope): void {
    if ((node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction") && node.id !== null) {
      this.#declare(scope, node.id.name);
      const binding = scope.bindings.get(node.id.name);
      if (node.type === "FunctionDeclaration" && binding?.initialBinding !== undefined) {
        // Hoisted functions replace the wrapper value before var initialization.
        // Keep explicit initializer/write inputs for conservative provenance.
        scope.bindings.set(node.id.name, { inputs: binding.inputs, mutable: binding.mutable });
      }
    }
    const parameters = this.#childScope(scope, "function");
    this.#nodeScopes.set(node, parameters);
    if (node.type !== "ArrowFunctionExpression" && node.id !== null) {
      this.#declare(parameters, node.id.name);
    }
    const varInitialBindings = new Map<string, LexicalBinding>();
    for (const parameter of node.params) {
      const pattern = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
      const argument = pattern.type === "RestElement" ? pattern.argument : pattern;
      this.#declarePattern(parameters, argument);
      for (const { name } of patternBindings(argument)) {
        const binding = parameters.bindings.get(name);
        if (binding !== undefined) {
          varInitialBindings.set(name, binding);
        }
      }
    }
    for (const child of childNodes(node)) {
      // Body var declarations do not shadow expressions evaluated in default parameters.
      this.#collect(child, child.type === "BlockStatement"
        ? { ...this.#childScope(parameters, "function"), varInitialBindings } : parameters);
    }
  }

  #collectImport(node: Extract<Node, { type: "ImportDeclaration" }>, scope: LexicalScope): void {
    if (node.importKind === "type") {
      return;
    }
    for (const specifier of node.specifiers) {
      if (specifier.type === "ImportSpecifier" && specifier.importKind === "type") {
        continue;
      }
      const namespace = builtinOrigin(node.source.value);
      let origin = namespace;
      if (specifier.type === "ImportSpecifier") {
        origin = memberOrigin(namespace, propertyName(specifier.imported, false));
      }
      this.#declare(scope, specifier.local.name, undefined, origin);
    }
  }

  #nestedScope(node: Node, parent: LexicalScope): LexicalScope {
    if (node.type === "StaticBlock" || node.type === "TSModuleBlock") {
      return this.#childScope(parent, "function");
    }
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      if (node.type === "ClassDeclaration" && node.id !== null) {
        this.#declare(parent, node.id.name);
      }
      const scope = this.#childScope(parent, "block");
      if (node.id !== null) {
        this.#declare(scope, node.id.name);
      }
      return scope;
    }
    if (node.type === "BlockStatement" || node.type === "ForStatement" ||
        node.type === "ForInStatement" || node.type === "ForOfStatement" || node.type === "CatchClause") {
      const scope = this.#childScope(parent, "block");
      if (node.type === "CatchClause" && node.param !== null) {
        this.#declarePattern(scope, node.param);
      }
      return scope;
    }
    return parent;
  }

  #collectDeclarations(node: Node, scope: LexicalScope): void {
    if (node.type === "TSModuleDeclaration" || node.type === "TSEnumDeclaration") {
      if (node.id.type === "Identifier") {
        this.#declare(scope, node.id.name);
      }
    } else if (node.type === "ImportDeclaration") {
      this.#collectImport(node, scope);
    } else if (node.type === "VariableDeclaration") {
      for (const declaration of node.declarations) {
        const target = node.kind === "var" ? this.#varScope(scope) : scope;
        if (node.kind === "var" && node.declare !== true) {
          this.#declareVar(target, declaration.id);
        }
        this.#declarePattern(target, declaration.id, declaration.init ?? undefined);
      }
    } else if (node.type === "TSImportEqualsDeclaration" && node.importKind !== "type") {
      const origin = node.moduleReference.type === "TSExternalModuleReference"
        ? builtinOrigin(node.moduleReference.expression.value) : undefined;
      this.#declare(scope, node.id.name, undefined, origin);
    }
  }

  #collect(node: Node, parent: LexicalScope): void {
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" ||
        node.type === "TSDeclareFunction" || node.type === "TSEmptyBodyFunctionExpression" ||
        node.type === "ArrowFunctionExpression") {
      this.#collectFunction(node, parent);
      return;
    }
    if (node.type === "SwitchStatement") {
      this.#nodeScopes.set(node, parent);
      this.#collect(node.discriminant, parent);
      const scope = this.#childScope(parent, "block");
      for (const child of node.cases) {
        this.#collect(child, scope);
      }
      return;
    }
    const scope = this.#nestedScope(node, parent);
    this.#collectDeclarations(node, scope);
    this.#nodeScopes.set(node, scope);
    for (const child of childNodes(node)) {
      this.#collect(child, scope);
    }
  }

  #markObject(expression: Expression, scope: LexicalScope, seen = new Set<LexicalBinding>()): void {
    const target = unwrapExpression(expression);
    if (target.type === "MemberExpression") {
      this.#markObject(target.object, scope, seen);
    } else if (target.type === "Identifier") {
      const binding = this.resolve(target.name, scope);
      if (binding !== undefined) {
        this.#markBindingObject(binding, seen);
      }
    }
  }

  #markBindingObject(binding: LexicalBinding, seen: Set<LexicalBinding>): void {
    if (seen.has(binding)) {
      return;
    }
    seen.add(binding);
    binding.mutable = true;
    // Object aliases share member writes, while reassigning an alias does not.
    if (binding.initialBinding !== undefined) {
      this.#markBindingObject(binding.initialBinding, seen);
    }
    for (const input of binding.inputs) {
      if (input.properties.length === 0) {
        this.#markObject(input.expression, this.scope(input.expression), seen);
      }
    }
  }

  #markTarget(target: Node, scope: LexicalScope, input?: BindingInput): void {
    if (target.type === "Identifier") {
      const binding = this.resolve(target.name, scope);
      if (binding !== undefined) {
        binding.mutable = true;
        if (input !== undefined) {
          binding.inputs.push(input);
        }
      }
      return;
    }
    if (target.type === "MemberExpression") {
      this.#markObject(target.object, scope);
      return;
    }
    if (target.type === "AssignmentPattern") {
      this.#markTarget(target.left, scope, input);
      this.#markTarget(target.left, scope, { expression: target.right, properties: [] });
      return;
    }
    if (target.type === "Property") {
      this.#markTarget(target.value, scope, input === undefined ? undefined : {
        ...input, properties: [...input.properties, propertyName(target.key, target.computed) ?? "<computed>"]
      });
      return;
    }
    // Array/rest projections cannot select a known namespace member.
    const projected = target.type === "ArrayPattern" || target.type === "RestElement"
      ? undefined : input;
    for (const child of childNodes(target)) {
      this.#markTarget(child, scope, projected);
    }
  }

  #markMutations(program: Program): void {
    const markIteration = (node: Extract<Node, { type: "ForInStatement" | "ForOfStatement" }>) => {
      const targets = node.left.type === "VariableDeclaration"
        ? node.left.declarations.map((declaration) => declaration.id) : [node.left];
      for (const target of targets) {
        this.#markTarget(target, this.scope(node));
      }
    };
    new Visitor({
      AssignmentExpression: (node) => {
        this.#markTarget(node.left, this.scope(node), { expression: node.right, properties: [] });
      },
      UpdateExpression: (node) => {
        this.#markTarget(node.argument, this.scope(node));
      },
      UnaryExpression: (node) => {
        if (node.operator === "delete") {
          this.#markTarget(node.argument, this.scope(node));
        }
      },
      ForInStatement: markIteration,
      ForOfStatement: markIteration
    }).visit(program);
  }
}
