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

## Disposable scaffold crash qualification

Developer tests can import `runScaffoldCrashQualification` and the types
`ScaffoldQualificationPhase`, `ScaffoldQualificationPoint`, and
`ScaffoldQualificationPhaseCallback` from
`@agent-teams/engineering-foundation/scaffolding/qualification`.
This testing-only entrypoint uses the existing production apply dependencies and
returns the existing `ScaffoldReceipt` for the existing `ScaffoldPlan`.
The entrypoint also explicitly reexports these canonical types and the types
referenced by their public signatures. These are the same type declarations as
the main scaffolding entrypoint; no parallel Plan or Receipt model is introduced.
Do not import it from production runtime code.

```ts
import { runScaffoldCrashQualification } from
  "@agent-teams/engineering-foundation/scaffolding/qualification";

// In a disposable fixture's writer child process, using a publicly planned Plan:
await runScaffoldCrashQualification(consumerRoot, plan, async point => {
  if (point.phase === "after-hard-link") process.exit(73);
});
```

The callback is required and must be a function; an invalid callback rejects
with `TypeError` before apply. Every supported event is awaited at its existing
checkpoint and receives a fresh frozen object containing only `phase`.
The supported phases are:

- `after-journal-temporary-synced`
- `after-journal-prepared`
- `before-operation-authority-recheck`
- `after-journal-operation-publishing`
- `after-temporary-synced`
- `after-hard-link`
- `after-journal-operation-published`
- `before-final-authority-recheck`
- `after-final-verification`
- `before-journal-quarantine`
- `after-journal-unlinked`

Events can repeat for operations and journal replacements; this list does not
promise a universal ordering or one event per phase. Private temporary-written,
recovery-scope, and unknown future events are excluded. Callback return values
grant no authority. Throws or rejections follow existing apply error/cleanup
behavior and do not demonstrate a crash. A normal receipt certifies no crash.

The caller owns the disposable fixture and child process. Run existing public
`recoverFilesystemScaffold` in a fresh process after exit 73, then check planned
bytes, production reapply idempotency, and preservation of user-owned drift.
The first journal temporary cut can fail closed on an orphan Foundation
transaction temporary; publication temporary-sync and hard-link cuts can require
bounded manual recovery. A final journal-unlinked cut can yield no recovery
receipt. Qualification does not promise convergence at every cut.

Callbacks are trusted test code with the caller's Node privileges, not sandboxed
code. The function does not spawn, kill, retry, recover, or clean up a fixture.
Exit 73 demonstrates process interruption, not physical power-loss durability;
existing filesystem and Windows directory-sync limitations still apply.
