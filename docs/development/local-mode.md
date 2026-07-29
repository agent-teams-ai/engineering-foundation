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
identity, built exports, and Git evidence before creating a pnpm link. It writes
only `.agent-teams-local/foundation-link.json`, which is excluded through the
consumer's local Git exclude file.

Status reports package version, source path, Git commit, dirty state, and one of:

- `REGISTRY`: exact manifest version installed beneath consumer `node_modules`;
- `LOCAL`: installed package resolves to the recorded local target;
- `INVALID`: marker, manifest, installed package, or source evidence disagree.

Detach removes the link and performs a frozen lockfile install. CI, package, and
release commands use `foundation:assert-registry` and reject local or ambiguous
state.
