# Workspace Dependency Declaration Rules

Status: Active capability contract version 1.

`workspace.dependency-declarations` reads `pnpm-workspace.yaml` and every
materialized workspace `package.json`. It does not inspect source imports or own
the consumer's package topology.

The capability enforces:

- unique, non-empty workspace package names;
- exact root `pnpm` version and strict catalog mode;
- exact versions in default and named catalogs;
- `workspace:` for internal package dependencies;
- `catalog:` or `catalog:<name>` for external dependencies;
- reserved-scope references resolving only to local workspace packages;
- one dependency section per package dependency;
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
