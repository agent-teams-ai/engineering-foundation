export const coordinate = Object.freeze({
  version: "0.1.0",
  integrity: `sha512-${"A".repeat(86)}==`,
});

export function hostileCyclicLockfile() {
  const packageNames = [
    "@agent-teams/repository-mutation",
    "@agent-teams/document-authoring",
    "@agent-teams/docs-protocol",
    "@agent-teams/docs-protocol-agent-teams",
    "@agent-teams/engineering-foundation",
  ];
  return {
    lockfileVersion: "9.0",
    importers: {
      ".": {
        devDependencies: Object.fromEntries(
          [
            "@agent-teams/docs-protocol",
            "@agent-teams/docs-protocol-agent-teams",
            "@agent-teams/engineering-foundation",
          ].map((name) => [
            name,
            {
              specifier: coordinate.version,
              version: coordinate.version,
            },
          ]),
        ),
      },
    },
    packages: Object.fromEntries(
      packageNames.map((name) => [
        `${name}@${coordinate.version}`,
        { resolution: { integrity: coordinate.integrity } },
      ]),
    ),
    snapshots: {
      "@agent-teams/repository-mutation@0.1.0": {
        dependencies: closureDependencies(["@agent-teams/docs-protocol"]),
      },
      "@agent-teams/document-authoring@0.1.0": {
        dependencies: closureDependencies(["@agent-teams/repository-mutation"]),
      },
      "@agent-teams/docs-protocol@0.1.0": {
        dependencies: closureDependencies([
          "@agent-teams/document-authoring",
          "@agent-teams/repository-mutation",
        ]),
      },
      "@agent-teams/docs-protocol-agent-teams@0.1.0": {
        dependencies: closureDependencies([
          "@agent-teams/docs-protocol",
          "@agent-teams/repository-mutation",
        ]),
      },
      "@agent-teams/engineering-foundation@0.1.0": {
        dependencies: closureDependencies([
          "@agent-teams/document-authoring",
          "@agent-teams/repository-mutation",
        ]),
      },
    },
  };
}

function closureDependencies(entries: readonly string[]) {
  return Object.fromEntries(entries.map((name) => [name, coordinate.version]));
}
