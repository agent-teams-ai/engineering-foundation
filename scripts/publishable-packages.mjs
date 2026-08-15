export const PUBLISHABLE_PACKAGES = Object.freeze([
  Object.freeze({
    changelogPath: "packages/engineering-foundation/CHANGELOG.md",
    manifestPath: "packages/engineering-foundation/package.json",
    name: "@agent-teams/engineering-foundation",
    required: true,
    root: "packages/engineering-foundation",
  }),
  Object.freeze({
    changelogPath: "packages/docs-protocol/CHANGELOG.md",
    manifestPath: "packages/docs-protocol/package.json",
    name: "@agent-teams/docs-protocol",
    root: "packages/docs-protocol",
  }),
]);

export function publishablePackageByName(name) {
  return PUBLISHABLE_PACKAGES.find((candidate) => candidate.name === name);
}
