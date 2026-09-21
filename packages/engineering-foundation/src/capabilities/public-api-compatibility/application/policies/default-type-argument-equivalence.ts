import type { PublicApiItem } from "../model/public-api.js";

const IDENTIFIER = "[A-Za-z_$][A-Za-z0-9_$]*";
const TYPE_ATOM = `${IDENTIFIER}(?:\\.${IDENTIFIER})*`;
const TYPE_ALIAS = new RegExp(
  `^(export type ${IDENTIFIER}(?:<([^<>\\r\\n]+)>)? = )(${IDENTIFIER})(?:<(${TYPE_ATOM}(?:, ${TYPE_ATOM})*)>)?;$`,
  "u"
);
const GENERIC_DECLARATION = new RegExp(
  `^export (?:(?:declare|abstract) )?(class|interface|type) (${IDENTIFIER})<([^<>\\r\\n]+)>(?=$| extends | implements | = )`,
  "u"
);
const TOP_LEVEL_TYPE_DECLARATION = new RegExp(
  `^export (?:(?:declare|abstract) )?(?:class|interface|type) (${IDENTIFIER})(?:<| |$)`,
  "u"
);
const TYPE_PARAMETER = new RegExp(
  `^(${IDENTIFIER})(?: extends (${TYPE_ATOM}))?(?: = (${TYPE_ATOM}))?$`,
  "u"
);
const LEADING_TYPE_NAME = new RegExp(`^(${IDENTIFIER})(?:\\.|$)`, "u");
const RESERVED_IDENTIFIERS = new Set([
  "any",
  "await",
  "bigint",
  "boolean",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "infer",
  "instanceof",
  "interface",
  "intrinsic",
  "keyof",
  "let",
  "never",
  "new",
  "null",
  "number",
  "object",
  "package",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "static",
  "string",
  "super",
  "switch",
  "symbol",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "unique",
  "unknown",
  "var",
  "void",
  "while",
  "with",
  "yield"
]);
const SUPPORTED_KEYWORD_TYPE_ATOMS = new Set([
  "any",
  "bigint",
  "boolean",
  "false",
  "never",
  "null",
  "number",
  "object",
  "string",
  "symbol",
  "this",
  "true",
  "undefined",
  "unknown",
  "void"
]);

interface DirectTypeAlias {
  readonly header: string;
  readonly parameterNames: ReadonlySet<string>;
  readonly target: string;
  readonly arguments: readonly string[];
}

interface GenericDeclaration {
  readonly name: string;
  readonly kind: "Class" | "Interface" | "TypeAlias";
  readonly parameterNames: ReadonlySet<string>;
  readonly defaults: readonly (string | undefined)[];
}

interface TypeParameterList {
  readonly names: readonly string[];
  readonly defaults: readonly (string | undefined)[];
}

function isSupportedTypeAtom(type: string): boolean {
  if (SUPPORTED_KEYWORD_TYPE_ATOMS.has(type)) {
    return true;
  }
  return type.split(".").every((part) => !RESERVED_IDENTIFIERS.has(part));
}

function parseTypeParameters(header: string): TypeParameterList | undefined {
  const names: string[] = [];
  const defaults: (string | undefined)[] = [];
  const seenNames = new Set<string>();
  let sawDefault = false;
  for (const parameter of header.split(", ")) {
    const match = TYPE_PARAMETER.exec(parameter);
    const name = match?.[1];
    const constraint = match?.[2];
    const defaultType = match?.[3];
    if (
      match === null ||
      name === undefined ||
      RESERVED_IDENTIFIERS.has(name) ||
      (constraint !== undefined && !isSupportedTypeAtom(constraint)) ||
      (defaultType !== undefined && !isSupportedTypeAtom(defaultType)) ||
      seenNames.has(name) ||
      (sawDefault && defaultType === undefined)
    ) {
      return undefined;
    }
    names.push(name);
    defaults.push(defaultType);
    seenNames.add(name);
    sawDefault = defaultType !== undefined;
  }
  return Object.freeze({
    names: Object.freeze(names),
    defaults: Object.freeze(defaults)
  });
}

function parseDirectTypeAlias(signature: string): DirectTypeAlias | undefined {
  const match = TYPE_ALIAS.exec(signature);
  if (match === null || match[1] === undefined || match[3] === undefined) {
    return undefined;
  }
  const parameters =
    match[2] === undefined
      ? Object.freeze({ names: Object.freeze([]), defaults: Object.freeze([]) })
      : parseTypeParameters(match[2]);
  if (parameters === undefined) {
    return undefined;
  }
  const aliasArguments = match[4]?.split(", ") ?? [];
  if (!aliasArguments.every(isSupportedTypeAtom)) {
    return undefined;
  }
  return Object.freeze({
    header: match[1],
    parameterNames: new Set(parameters.names),
    target: match[3],
    arguments: Object.freeze(aliasArguments)
  });
}

function parseGenericDeclaration(signature: string): GenericDeclaration | undefined {
  const match = GENERIC_DECLARATION.exec(signature);
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return undefined;
  }
  const parameters = parseTypeParameters(match[3]);
  if (parameters === undefined) {
    return undefined;
  }
  return Object.freeze({
    name: match[2],
    kind:
      match[1] === "class"
        ? "Class"
        : match[1] === "interface"
          ? "Interface"
          : "TypeAlias",
    parameterNames: new Set(parameters.names),
    defaults: parameters.defaults
  });
}

function unchangedTopLevelType(
  name: string,
  releasedItems: readonly PublicApiItem[],
  currentItems: readonly PublicApiItem[]
): PublicApiItem | undefined {
  const candidates = (items: readonly PublicApiItem[]) =>
    items.filter((item) => {
      if (item.parentKind !== "EntryPoint") {
        return false;
      }
      return TOP_LEVEL_TYPE_DECLARATION.exec(item.signature)?.[1] === name;
    });
  const released = candidates(releasedItems);
  const current = candidates(currentItems);
  if (released.length !== 1 || current.length !== 1) {
    return undefined;
  }
  const before = released[0];
  const after = current[0];
  if (
    before === undefined ||
    after === undefined ||
    before.canonicalReference !== after.canonicalReference ||
    before.kind !== after.kind ||
    before.parentKind !== after.parentKind ||
    before.parentReference !== after.parentReference ||
    before.signature !== after.signature
  ) {
    return undefined;
  }
  return before;
}

function unchangedTarget(
  name: string,
  releasedItems: readonly PublicApiItem[],
  currentItems: readonly PublicApiItem[]
): GenericDeclaration | undefined {
  const target = unchangedTopLevelType(name, releasedItems, currentItems);
  if (target === undefined) {
    return undefined;
  }
  const declaration = parseGenericDeclaration(target.signature);
  return declaration?.kind === target.kind ? declaration : undefined;
}

function hasUnchangedTypeAtomBinding(
  type: string,
  releasedItems: readonly PublicApiItem[],
  currentItems: readonly PublicApiItem[]
): boolean {
  if (SUPPORTED_KEYWORD_TYPE_ATOMS.has(type)) {
    return true;
  }
  if (type.includes(".")) {
    return false;
  }
  return unchangedTopLevelType(type, releasedItems, currentItems) !== undefined;
}

function omittedArgumentsEqualDefaults(
  shorter: DirectTypeAlias,
  longer: DirectTypeAlias,
  declaration: GenericDeclaration,
  releasedItems: readonly PublicApiItem[],
  currentItems: readonly PublicApiItem[]
): boolean {
  if (
    shorter.arguments.length >= longer.arguments.length ||
    longer.arguments.length > declaration.defaults.length
  ) {
    return false;
  }
  for (const [index, argument] of shorter.arguments.entries()) {
    if (longer.arguments[index] !== argument) {
      return false;
    }
  }
  for (
    let index = shorter.arguments.length;
    index < longer.arguments.length;
    index += 1
  ) {
    const declaredDefault = declaration.defaults[index];
    const leadingName =
      declaredDefault === undefined
        ? undefined
        : LEADING_TYPE_NAME.exec(declaredDefault)?.[1];
    if (
      declaredDefault === undefined ||
      declaredDefault !== longer.arguments[index] ||
      leadingName === undefined ||
      declaration.parameterNames.has(leadingName) ||
      shorter.parameterNames.has(leadingName) ||
      !hasUnchangedTypeAtomBinding(declaredDefault, releasedItems, currentItems)
    ) {
      return false;
    }
  }
  return true;
}

/** A comparison-only exception for one direct type-alias default-argument spelling. */
export function hasEquivalentTrailingDefaultTypeArguments(input: {
  readonly releasedItem: PublicApiItem;
  readonly currentItem: PublicApiItem;
  readonly releasedItems: readonly PublicApiItem[];
  readonly currentItems: readonly PublicApiItem[];
}): boolean {
  if (
    input.releasedItem.kind !== "TypeAlias" ||
    input.currentItem.kind !== "TypeAlias" ||
    input.releasedItem.parentKind !== "EntryPoint" ||
    input.currentItem.parentKind !== "EntryPoint"
  ) {
    return false;
  }
  const released = parseDirectTypeAlias(input.releasedItem.signature);
  const current = parseDirectTypeAlias(input.currentItem.signature);
  if (
    released === undefined ||
    current === undefined ||
    released.header !== current.header ||
    released.target !== current.target ||
    released.parameterNames.has(released.target) ||
    current.parameterNames.has(current.target)
  ) {
    return false;
  }
  const target = unchangedTarget(
    released.target,
    input.releasedItems,
    input.currentItems
  );
  if (target === undefined) {
    return false;
  }
  return released.arguments.length < current.arguments.length
    ? omittedArgumentsEqualDefaults(
        released,
        current,
        target,
        input.releasedItems,
        input.currentItems
      )
    : omittedArgumentsEqualDefaults(
        current,
        released,
        target,
        input.releasedItems,
        input.currentItems
      );
}
