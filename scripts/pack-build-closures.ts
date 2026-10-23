function fail(message: string): never {
  throw new Error(`Publishable artifact staging is invalid: ${message}`);
}
export function deriveBuildClosures(
  packages: readonly { name: string }[],
  dependencyDeclarations: unknown,
  byName: ReadonlyMap<string, unknown>,
): Map<string, readonly string[]> {
  if (
    dependencyDeclarations === null ||
    typeof dependencyDeclarations !== "object" ||
    Array.isArray(dependencyDeclarations)
  ) {
    fail("dependency declarations must be the manifest-derived projection");
  }
  const declarationsByName = Object.fromEntries<unknown>(Object.entries(dependencyDeclarations));
  const typedDeclarations = new Map<string, { name: string; section: string }[]>();
  for (const name of Object.keys(declarationsByName)) {
    if (!byName.has(name)) {
      fail(`dependency declarations name unknown package ${name}`);
    }
  }
  const state = new Map<string, string>();
  const closures = new Map<string, Set<string>>();
  const visit = (name: string, trail: readonly string[]): Set<string> => {
    if (!byName.has(name)) {
      fail(`unresolved internal support package ${name}`);
    }
    if (state.get(name) === "visiting") {
      fail(`internal dependency cycle includes ${[...trail, name].join(" -> ")}`);
    }
    if (state.get(name) === "visited") {
      return closures.get(name)!;
    }
    const declarations = declarationsByName[name];
    if (!Array.isArray(declarations)) {
      fail(`dependency declarations are missing package ${name}`);
    }
    state.set(name, "visiting");
    const closure = new Set([name]);
    const validated: { name: string; section: string }[] = [];
    for (const item of declarations) {
      const declaration: unknown = item;
      if (
        declaration === null ||
        typeof declaration !== "object" ||
        !("name" in declaration) ||
        typeof declaration.name !== "string" ||
        !("section" in declaration) ||
        typeof declaration.section !== "string"
      ) {
        fail(`${name} has a malformed internal dependency declaration`);
      }
      validated.push({ name: declaration.name, section: declaration.section });
      for (const dependency of visit(declaration.name, [...trail, name])) {
        closure.add(dependency);
      }
    }
    typedDeclarations.set(name, validated);
    state.set(name, "visited");
    closures.set(name, closure);
    return closure;
  };
  for (const { name } of packages) {
    visit(name, []);
  }
  const order = new Map(packages.map(({ name }, index) => [name, index]));
  for (const { name } of packages) {
    for (const { name: dependencyName } of typedDeclarations.get(name)!) {
      if (order.get(dependencyName)! >= order.get(name)!) {
        fail(`manifest-derived package order places ${name} before support ${dependencyName}`);
      }
    }
  }
  return new Map(
    packages.map(({ name }) => [
      name,
      Object.freeze(
        [...closures.get(name)!].toSorted((left, right) => order.get(left)! - order.get(right)!),
      ),
    ]),
  );
}
