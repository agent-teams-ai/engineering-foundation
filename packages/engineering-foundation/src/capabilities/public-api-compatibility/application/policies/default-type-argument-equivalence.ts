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
  `^(${IDENTIFIER})(?: extends ${TYPE_ATOM})?(?: = (${TYPE_ATOM}))?$`,
  "u"
);
const LEADING_TYPE_NAME = new RegExp(`^(${IDENTIFIER})(?:\\.|$)`, "u");

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

function parseTypeParameters(header: string): TypeParameterList | undefined {
  const names: string[] = [];
  const defaults: (string | undefined)[] = [];
  const seenNames = new Set<string>();
  let sawDefault = false;
  for (const parameter of header.split(", ")) {
    const match = TYPE_PARAMETER.exec(parameter);
    const name = match?.[1];
    const defaultType = match?.[2];
    if (
      match === null ||
      name === undefined ||
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
  return Object.freeze({
    header: match[1],
    parameterNames: new Set(parameters.names),
    target: match[3],
    arguments: Object.freeze(match[4]?.split(", ") ?? [])
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

function unchangedTarget(
  name: string,
  releasedItems: readonly PublicApiItem[],
  currentItems: readonly PublicApiItem[]
): GenericDeclaration | undefined {
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
  const declaration = parseGenericDeclaration(before.signature);
  return declaration?.kind === before.kind ? declaration : undefined;
}

function omittedArgumentsEqualDefaults(
  shorter: DirectTypeAlias,
  longer: DirectTypeAlias,
  declaration: GenericDeclaration
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
      shorter.parameterNames.has(leadingName)
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
    released.target !== current.target
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
    ? omittedArgumentsEqualDefaults(released, current, target)
    : omittedArgumentsEqualDefaults(current, released, target);
}
