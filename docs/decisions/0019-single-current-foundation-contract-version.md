---
id: ADR-0019
status: accepted
supersedes:
  - ADR-0016
superseded_by: []
---

# ADR-0019: Single Current Foundation Contract Version

Status: Accepted

Date: 2026-08-08

Decision owner: Product owner

## Context

Foundation is still before independent production adoption. Short-lived
hardening changes created parallel Foundation-owned `v1` and `v2` schemas in
Public API, Protobuf qualification and Scaffolding. Preserving migration
machinery now makes the first contract harder to understand without protecting
a consumer that cannot update atomically.

The hardening introduced by the newer shapes remains mandatory. In particular,
the complete Buf transition binding, process cancellation, contained atomic
evidence publication, multi-entrypoint Public API coverage, stable ADR identity,
source-bound Scaffolding authority and recovery guarantees cannot be weakened.

## Decision

1. Every current Foundation-owned configuration, evidence and protocol contract
   uses its single initial identity, `v1`. The current package ships one schema
   and one behavior path for each contract.
2. Before independent production adoption, a breaking contract correction
   replaces the current `v1` shape. Foundation and every known consumer are
   updated in one coordinated release and adoption wave. No compatibility
   reader, alias, migration router or parallel legacy schema is added to the
   current package.
3. Published npm artifacts and accepted or superseded ADRs remain immutable
   historical evidence. A consumer recovering persisted work from an older
   package uses that exact pinned registry artifact; the current package does
   not emulate it.
4. A Foundation-owned `v2` requires a new accepted ADR and evidence of a real
   migration boundary: at least one independently deployed, exactly pinned
   consumer or persisted contract instance that cannot be updated atomically.
   The ADR must define compatibility direction, migration evidence, support
   window and retirement criteria.
5. Package SemVer and versions owned by external specifications or tools are
   outside this rule. Examples include Buf config `version: v2`, SARIF 2.1.0,
   JSON Schema drafts and third-party action versions. Documentation must label
   them as external rather than Foundation contract versions.
6. The complete operational and security hardening of ADR-0016 remains active,
   but its Foundation producer and evidence identities are the sole `v1`.
   The canonical inline Buf config still uses external Buf format `v2`.

## Consequences

- Public API, Protobuf qualification and Scaffolding expose one current `v1`
  contract without compatibility branches.
- Breaking pre-adoption corrections require a coordinated update of Foundation,
  Agent Runtime, Orchestrator and Platform instead of a parallel schema.
- A repository test rejects a current Foundation-owned `v2` schema or protocol
  identity while permitting explicitly documented external formats.
- Future version coexistence is introduced only when actual deployment evidence
  justifies its cost.

## Rejected alternatives

- Keep short-lived `v1` and `v2` contracts for hypothetical compatibility.
- Rename the external Buf configuration format controlled by Buf.
- Mutate already published npm artifacts or accepted ADR history.
