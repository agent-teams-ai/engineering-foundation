# Local Foundation Mode

Registry mode is always the reproducible default. `package.json` and the lockfile
keep an exact published foundation version.

Local development is explicit:

```text
foundation:attach <absolute-path>
foundation:status
foundation:detach
foundation:assert-dev-only
foundation:assert-registry
```

`assert-dev-only` requires one exact version in `devDependencies` and rejects
runtime, bundled, overridden, resolved, or patched declarations.

`assert-registry` also parses `pnpm-lock.yaml` structurally. The root importer
specifier must equal the manifest version. Its resolution must be that exact
version, optionally followed by pnpm's peer-context suffix, and the matching
snapshot must exist. The lockfile must contain the exact npm package key and
sha512 integrity, with no
file/link/workspace/git/http source, override, patch, or non-npm tarball. The
same provenance must be present in the installed pnpm virtual-store lockfile;
this detects stale `node_modules` after a lockfile-only change.

Attach validates that registry evidence first. It then validates the target
package identity, versioned local-mode protocol and compatibility metadata,
required exports and build outputs, resolvable runtime dependencies, real CLI
self-check, and Git evidence before creating a package-manager-neutral directory
link beneath consumer `node_modules`. Durable recovery state is synced before
replacement: real package directories move to a local backup, while pnpm
symlink/junction entries get an absolute recovery link. It does not modify
`package.json`, `pnpm-workspace.yaml`, or the lockfile. Foundation-owned marker,
backup, and operation-lock artifacts stay beneath `.agent-teams-local/`, which
must be a real directory inside the consumer and is excluded through the
consumer's local Git exclude file.

Status reports package version, source path, Git commit, dirty state, and one of:

- `REGISTRY`: exact development-only manifest and npm lockfile evidence match
  the installed package identity and version beneath consumer `node_modules`;
- `LOCAL`: installed package resolves to the recorded local target;
- `INVALID`: marker, manifest, installed package, or source evidence disagree.

Detach removes only the foundation link and atomically restores the preserved
registry package entry. It never runs a workspace install. A consumer-scoped
`proper-lockfile` lock rejects concurrent mutations and safely reclaims stale
locks. Durable `ATTACHING` and `DETACHING` phases let a later detach finish
recovery after process interruption.

`NodeProcessRunner` preserves the pre-existing no-deadline behavior when
`timeoutMs` is omitted and validates an explicit deadline before process
creation. Cancellation and deadlines terminate the platform containment
boundary. Windows uses a Job Object for strict descendant containment. POSIX
uses a process group; a child that deliberately creates a new session leaves
that portable boundary and must be governed by a stronger host sandbox when
adversarial process containment is required.

On POSIX filesystems, file and directory syncs also preserve mutation ordering
across ordinary power loss. Node cannot portably fsync directories on Windows,
so Windows provides process-crash recovery but does not claim the same hard
power-loss guarantee. The package gate exercises the real lifecycle
against an isolated tarball consumer. CI, package, and release commands use
`foundation:assert-registry` and reject local or ambiguous state.

The registry assertion proves package-manager provenance from the consumer
manifest and lockfile. It does not claim to cryptographically re-hash every
expanded file beneath `node_modules`; clean frozen installs remain a release and
CI requirement.
