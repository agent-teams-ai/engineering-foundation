# Scoped Scaffolding Recovery

`recoverFilesystemScaffold` retains its original one-argument form and adds a
descriptor-stable overload:

```ts
import {
  recoverFilesystemScaffold,
  type ScaffoldRecoveryScope
} from "@agent-teams/engineering-foundation/scaffolding";

const scope: ScaffoldRecoveryScope = {
  projectId: "example",
  configPath: "architecture/foundation/scaffolding.yaml",
  targetCatalogPath: "architecture/package-catalog.yaml",
  compositionId: "library-boundary"
};

const receipt = await recoverFilesystemScaffold(consumerRoot, scope);
```

The v1 scope is immutable: it has exactly the four string properties shown
above, and their meaning and validation cannot be narrowed without a new
contract version. IDs use the published scaffolding authority-ID syntax. Paths
match the published v1 repository-path regex exactly:
`^(?!.*(?:^|/)\.{1,2}(?:/|$))[A-Za-z0-9._@-]+(?:/[A-Za-z0-9._@-]+)*$`.
Foundation does not add host-specific restrictions; for example, a matching
Windows device-name segment or trailing dot remains schema-valid. It compares
strings exactly without host normalization or case folding. It snapshots and
freezes a valid scope synchronously, so later caller mutation cannot retarget
recovery.

An idle repository returns `undefined`. Malformed scope input reports
`SCAFFOLD_INPUT_INVALID`. A valid scope that does not match the prepared journal
reports `SCAFFOLD_RECOVERY_REQUIRED` with
`scaffolding.recovery.scope-mismatch`; the journal, outputs, and transaction
barrier remain in place.

The match covers the journal Plan's `projectId`, authority `configPath`, authority
`targetCatalogPath`, Intent `compositionId`, and resolved Composition `id`.
Foundation checks the same stored record that it passes to continuation before
authority reads, classification, journal replacement, or publication. Existing
temporary, quarantine, retired, cleanup-residue, and version-routing behavior is
unchanged.

`inspectFoundationTransactionAwareMode` remains the only public read-only
preflight. Its transaction status is advisory; callers that need mutation-time
binding use scoped recovery. There is intentionally no `planDigest` in this
value: callers holding the exact saved Plan can use `applyFilesystemScaffold`.
The scope adds no journal field, envelope, schema version, callback, metadata
extension, or repository-root identity, so recovery remains portable across a
cloned repository under the documented cooperative-writer threat model.
