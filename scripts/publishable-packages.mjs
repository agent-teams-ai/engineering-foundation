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
  Object.freeze({
    changelogPath: "packages/docs-protocol-mcp/CHANGELOG.md",
    manifestPath: "packages/docs-protocol-mcp/package.json",
    name: "@agent-teams/docs-protocol-mcp",
    root: "packages/docs-protocol-mcp",
  }),
]);

export const PUBLISHABLE_PACKAGE_DEPENDENCIES = Object.freeze({
  "@agent-teams/engineering-foundation": Object.freeze([]),
  "@agent-teams/docs-protocol": Object.freeze(["@agent-teams/engineering-foundation"]),
  "@agent-teams/docs-protocol-mcp": Object.freeze(["@agent-teams/docs-protocol"]),
});

export function publishablePackageByName(name) {
  return PUBLISHABLE_PACKAGES.find((candidate) => candidate.name === name);
}
