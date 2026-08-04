---
id: ADR-0014
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0014: Scaffolding Review Hardening

Status: Accepted

Date: 2026-08-05

Decision owner: Product owner

## Context

Adversarial review of the source-bound scaffolding implementation found six
gaps before its first release: caller-owned Plans could change after
validation, crash-left journal temporaries had no durable ownership proof,
special files could block a read before regular-file validation, plan-bound
Receipts could omit operation evidence for selected outcomes, malformed UTF-8
was decoded lossily, and the exported target-catalog type did not match its
canonical JSON Schema wire names. Follow-up review also found that an
unsnapshotable runtime Plan and selected non-regular journal paths could escape
the typed scaffolding failure contract.

These findings affect authority, recovery, and the public TypeScript surface.
They must be corrected before the source-bound contract is released or used to
qualify a reusable Recipe.

## Decision

1. Apply synchronously snapshots and freezes the caller Plan before its first
   asynchronous boundary. Validation, authority checks, journaling, publication,
   and Receipts use only that snapshot. Snapshot failures are normalized to the
   typed invalid-Plan outcome.
2. A journal temporary found after process continuity is lost is not ownership
   evidence. Foundation preserves it and requires explicit recovery instead of
   promoting or deleting it.
3. POSIX bounded reads use non-blocking open semantics and reject every
   non-regular file. This prevents FIFO and device paths from holding an
   operation lock indefinitely, while journal reads normalize special-file
   failures to the typed recovery-required outcome.
4. Every Receipt validated against a Plan provides exactly one evidence record
   for every Plan operation, including `rejected` and `recovery-required`
   outcomes.
5. Every canonical repository source is decoded as strict UTF-8 before newline
   normalization and hashing. Malformed input fails closed.
6. `ScaffoldTargetCatalog` is the public wire contract and therefore uses the
   schema fields `package_name` and `owner_document`. Normalized compiler input
   continues to use the separate `ScaffoldTarget` model.
7. Approve the exact public API fingerprint
   `sha256:cd3b61b7d835a912ddbd87d9c4a7b3e26efa39b9f0638cad7fba9317b1fe5d07`
   for the next pre-1.0 release.

## Consequences

- Mutation after validation cannot redirect a reviewed Plan.
- Crash recovery may require manual resolution when creator-handle identity no
  longer exists; availability does not override deletion or promotion authority.
- Repository-controlled special files and malformed bytes fail closed without
  ambiguous evidence.
- Schema-valid target catalogs compile against the published TypeScript API.
- Receipt consumers can account for every planned operation for every outcome.
- The fingerprint approval is exact and authorizes no other public API change.

## Rejected alternatives

- Trust matching temporary bytes as proof that Foundation created the path.
- Preserve lossy UTF-8 decoding and hash replacement characters.
- Keep a camelCase public catalog type beside a snake_case canonical schema.
- Require complete operation evidence only for successful Receipts.
