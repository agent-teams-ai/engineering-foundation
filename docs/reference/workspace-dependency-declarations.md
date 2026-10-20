# Workspace Dependency Declaration Rules

Status: Active capability contract version 1; configuration schemas v1 and v2.

`workspace.dependency-declarations` reads `pnpm-workspace.yaml` and every
materialized workspace `package.json`. It does not inspect source imports or own
the consumer's package topology.

Configuration v1 selects `pnpm`. Additive configuration v2 selects exactly
`pnpm` or `bun` through `packageManager.kind`; the root `packageManager` must
match that kind and pin an exact semantic version. Ranges, tags, missing values
and a different manager produce the same package-manager rule finding.
Both versions explicitly use `workspaceManifest: pnpm-workspace.yaml` for
workspace membership and catalogs. V2 does not claim support for workspaces
whose only authority is Bun's native manifest format.

```yaml
schemaVersion: 2
packageManager:
  kind: bun
  workspaceManifest: pnpm-workspace.yaml
# The existing policies block remains required and unchanged.
```

The capability enforces:

- unique, non-empty workspace package names;
- an exact root package-manager version matching the configured kind, and strict catalog mode;
- exact versions in default and named catalogs;
- exact pnpm npm aliases such as `npm:package@1.2.3`, while aliases targeting
  ranges or tags remain prohibited;
- `workspace:` for internal package dependencies;
- `catalog:` or `catalog:<name>` for external dependencies;
- reserved-scope references resolving only to local workspace packages;
- one dependency section per package dependency, except a peer contract paired
  with the development dependency used to build and test that contract; both
  declarations still obey their version and placement rules;
- development-only placement for compiler and lint tooling;
- exact direct registry pins for explicitly listed local-mode tooling such as
  engineering foundation, while ordinary tooling versions remain catalog-owned;
- no bundling of development-only packages.

Malformed manifests and configuration produce `invalid-input` rather than a
partial pass. Policy findings produce stable rule IDs and exit code `1`. Use:

```bash
agent-teams-foundation explain <rule-id>
```

Rules cannot be downgraded or suppressed in capability contract version 1.
Consumer-specific exceptions require an architecture decision and a future
versioned waiver contract; ad hoc ignores are prohibited.
