---
id: ADR-0030
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0030: Recoverable Known-File Transactions

Status: Accepted

Date: 2026-08-16

Decision owner: Product owner

## Context

Foundation can publish an absent file, serialize cooperative mutations, and
recover document-authoring journals. Managed consumer integration also needs to
replace existing package-owned files and bounded fields. Docs Protocol must not
implement a second filesystem writer, and create-only scaffolding cannot be
reinterpreted as update authority.

Portable filesystems do not provide one atomic syscall for replacing several
paths. The contract must report this honestly while preventing stale plans,
unknown content, and ambiguous crash state from being overwritten.

## Decision

1. Foundation owns a closed `replace-known-file/v1` transaction protocol under
   its existing `./mutation` package boundary.
2. A transaction contains only repository-relative create-absent or
   replace-known-file operations. Every replacement binds exact preimage bytes,
   digest, size, mode, and stable file identity observed under the Foundation
   operation barrier. Every postimage binds exact bytes, digest, size, and mode.
3. The public API accepts inert data only. It exposes no callbacks, hooks,
   commands, template engines, consumer plugins, deletes, renames, or arbitrary
   recovery handlers.
4. Apply recompiles or validates the complete Plan, requires its expected
   digest, acquires the existing repository-wide Foundation barrier, and
   recaptures every path and ancestor before mutation. A stale or unknown
   preimage fails closed.
5. Operations execute as serialized CAS replacements recorded in one versioned
   journal. A crash may expose a temporary mixed state. Exact-build recovery
   either completes the remaining proven operations or conditionally restores
   an already replaced file only while its current bytes and identity still
   equal the transaction postimage.
6. The protocol does not claim multi-file atomicity or protection from an
   arbitrary same-user editor. Required CI is the merge barrier that prevents a
   partial cohort from reaching the default branch.
7. User-requested delete is absent. Recovery may remove only a transaction
   temporary or destination whose exact identity is recorded in the journal,
   or an identity-bound, still-empty directory proven to have been created by
   that transaction.
8. Unknown, corrupt, incompatible, rebuilt-same-version, or third-party-modified
   evidence is preserved for manual recovery. Journals are never migrated or
   reinterpreted.
9. Linux and macOS apply require strict directory durability. Windows v1
   supports read-only inspection and planning but rejects apply unless a
   separately qualified strict durability adapter is available.
10. Receipt, Plan, journal, and diagnostic schemas are versioned and bounded.
    They contain no timestamps, absolute paths, process identifiers, locale, or
    network-derived state.
11. Identity checks and path operations are serialized against cooperative
    Foundation writers. Portable Node filesystem APIs do not provide `unlinkat`
    or `renameat` handle-relative publication, so the protocol does not claim
    protection from a hostile same-user process swapping paths between proof
    and use.

## Consequences

- Docs Protocol can delegate all repository writes to one Foundation authority.
- Repeated apply is deterministic and no-op when every postimage is already
  exact.
- A failed process can leave recoverable evidence and a visible mixed state,
  but never an unrecorded successful update.
- The narrow operation vocabulary avoids turning Foundation into a generic
  managed-files framework.

## Rejected alternatives

- Add replace behavior to create-only scaffolding without a new contract.
- Implement package, AGENTS, Skill, or workflow writers inside Docs Protocol.
- Claim atomic multi-file commit from sequential filesystem operations.
- Permit `--force`, wildcard ownership, delete, rename, or executable hooks.
