export const registryInstallManagers = Object.freeze(["npm", "pnpm"]);

export function registryInstallMatrix({
  docsPackageName,
  managers = registryInstallManagers,
  mcpPackageName,
}) {
  if (typeof docsPackageName !== "string" || typeof mcpPackageName !== "string") {
    throw new Error("Registry install matrix requires Docs Protocol package names.");
  }
  if (
    !Array.isArray(managers) || managers.length === 0 ||
    managers.some((manager) => !registryInstallManagers.includes(manager)) ||
    new Set(managers).size !== managers.length
  ) {
    throw new Error("Registry install matrix contains unsupported package managers.");
  }
  return Object.freeze(managers.flatMap((manager) => [
    Object.freeze({
      id: `${manager}-docs-only`,
      manager,
      packageNames: Object.freeze([docsPackageName]),
      profile: "docs-only",
    }),
    Object.freeze({
      id: `${manager}-docs-mcp`,
      manager,
      packageNames: Object.freeze([docsPackageName, mcpPackageName]),
      profile: "docs-mcp",
    }),
  ]));
}

export function exactPublicCoordinateDecision({ coordinates, publishedVersions }) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    throw new Error("Public coordinate qualification requires at least one coordinate.");
  }
  const missing = coordinates.filter(({ name, version }) =>
    !Array.isArray(publishedVersions?.[name]) ||
    !publishedVersions[name].includes(version),
  );
  return Object.freeze({
    coordinates: Object.freeze(coordinates.map(({ name, version }) =>
      Object.freeze({ name, version }))),
    missing: Object.freeze(missing.map(({ name, version }) =>
      Object.freeze({ name, version }))),
    status: missing.length === 0 ? "ready" : "pending",
  });
}
