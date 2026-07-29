# Local Foundation Mode

Registry mode is always the reproducible default. `package.json` and the lockfile
keep an exact published foundation version.

Local development is explicit:

```text
foundation:attach <absolute-path>
foundation:status
foundation:detach
foundation:assert-registry
```

Attach validates the consumer's exact registry dependency, the target package
identity, built exports, and Git evidence before creating a package-manager-neutral
directory link beneath consumer `node_modules`. Durable recovery state is synced
before replacement: real package directories move to a local backup, while
pnpm symlink/junction entries get an absolute recovery link. It does not modify
`package.json`, `pnpm-workspace.yaml`, or the lockfile. Foundation-owned marker,
backup, and operation-lock artifacts stay beneath `.agent-teams-local/`, which
is excluded through the consumer's local Git exclude file.

Status reports package version, source path, Git commit, dirty state, and one of:

- `REGISTRY`: exact manifest version installed beneath consumer `node_modules`;
- `LOCAL`: installed package resolves to the recorded local target;
- `INVALID`: marker, manifest, installed package, or source evidence disagree.

Detach removes only the foundation link and atomically restores the preserved
registry package entry. It never runs a workspace install. A consumer-scoped
operation lock rejects concurrent mutations and reclaims locks left by dead
processes. Durable `ATTACHING` and `DETACHING` phases let a later detach finish
recovery after interruption. The package gate exercises this real lifecycle
against an isolated tarball consumer. CI, package, and release commands use
`foundation:assert-registry` and reject local or ambiguous state.
