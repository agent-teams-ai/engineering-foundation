export const PUBLISHABLE_PACKAGES = Object.freeze([
  Object.freeze({
    changelogPath: "packages/engineering-foundation/CHANGELOG.md",
    manifestPath: "packages/engineering-foundation/package.json",
    name: "@agent-teams/engineering-foundation",
    required: true,
    root: "packages/engineering-foundation",
  }),
]);

export function publishablePackageByName(name) {
  return PUBLISHABLE_PACKAGES.find((candidate) => candidate.name === name);
}
