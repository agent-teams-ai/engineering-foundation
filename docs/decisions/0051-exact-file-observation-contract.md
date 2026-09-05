---
id: ADR-0051
status: accepted
supersedes: []
superseded_by: []
primitiveScopes:
  packages/repository-mutation/src/path-identity.ts:
    semantics: Erased physical-observation contracts PortablePathIdentity, PathIdentityMatch
      and the original BoundedRegularFileRead. Preserve readonly bigint birthtimeNs, dev
      and ino; different, match and missing identity alternatives; and the readonly
      read/changed/invalid union with Buffer bytes, PortablePathIdentity identity,
      bigint linkCount and numeric mode on read. No observation or matching implementation.
    owner: Repository Mutation maintainers; portable observed file identity and read contract
    rationale: Known-file transactions and mutation coordination exchange the same bounded
      physical observation. Neither workflow owns the other's observation value or
      lifecycle. Duplicating the released type would split its exported symbol and
      break API extraction even when structural assignment succeeds.
    purity: Exactly three erased type declarations; no imports, runtime implementation,
      observation state or IO. Preserve original readonly, union, Buffer, bigint and mode
      semantics and public symbol identity across all consuming features and surfaces.
    versioning: Same-owner caller-path moves update the profile and tests. Changes to
      semantics, owning responsibility, exact source scope, versioning or consuming
      identities require a successor ADR and compatibility evidence. Existing released
      API, schema and recovery baselines remain authoritative and are not promoted here.
    reviewTrigger: Any new consuming identity, source-scope expansion, changed type name,
      union alternative, readonly field, Buffer/bigint/mode semantics, import, runtime
      operation, observation implementation or state; changed version or compatibility policy.
    consumers:
      - document-authoring/document-authoring
      - engineering-foundation/scaffolding
      - engineering-foundation/transaction-coordination
      - repository-mutation/@assembly
      - repository-mutation/known-file-transactions
      - repository-mutation/mutation-coordination
---

# ADR-0051: Exact File Observation Contract

Date: 2026-09-05

Decision owner: Repository architecture coordinator, within the user-authorized
hardening implementation. This accepted decision records the coordinator's
explicit acceptance of the qualified co-location recommendation before moving
declarations. It does not claim independent reviewer or additional human or
product-owner approval.

## Decision

Admit only `packages/repository-mutation/src/path-identity.ts` with the three
existing types named above. This supplements ADR-0047 and succeeds only its
exact path-identity admission. Its other primitive admissions and ADR-0050's JSON
admissions remain in force; their accepted bytes and immutable standard v1 remain
unchanged. The empty whole-decision `supersedes` list reflects this partial scope.

Move the original `BoundedRegularFileRead` declaration verbatim from mutation
coordination's application beside `PortablePathIdentity` and `PathIdentityMatch`.
Retain its original symbol through existing type re-exports, aliases and public
surfaces. The file owns technical observation data shared across workflows;
it conveys no authority to read, match, mutate or recover a filesystem path.
The readonly fields do not freeze the Buffer or add runtime immutability.

Terminal-directory authority, observation implementations, filesystem handles,
leases, claim admission and recovery policy remain feature-owned. There is no
shared workflow, business domain, observation implementation, state or IO here.
Co-location needs no primitive-to-primitive dependency, grammar extension,
source-policy permission change, new package or public export.

The [feature profile](../../architecture/foundation/feature-modules.json) retains
the six closed consumer identities and their existing callers. It points this
exact scope at ADR-0051 and adds only `transaction-coordination/application-api.ts`
under the existing `repository-mutation/mutation-coordination` identity. Existing
source-policy, caller observation, layer, cycle and finite purity checks apply.

## Compatibility and qualification

The source checkpoint is `ef355d976df82b9934a48f525fdb5d41697e60d5`. The supplied
review qualified this co-location in a disposable fixture: all 79 Mutation
JavaScript outputs were byte-identical, the seven frozen public typed surfaces
retained the five existing reader projections, and the unchanged feature checker
removed only the retained Mutation ownership edge. This is design evidence;
the implemented successor must independently retain the acceptance evidence below.

Require a pinned build and a byte comparison of all 79 emitted JavaScript files,
the unchanged seven-surface frozen API Extractor regression, and the unchanged
installed-consumer bidirectional reader assignments plus apply/replay/recovery.
The exact-primitive regression must require only these three erased declarations,
no imports or runtime behavior, and reject added `Date.now()` pollution. The whole
Mutation boundary regression must pass with no new feature findings. Existing
lease, journal, cleanup and cancellation evidence retains its behavior scope.

Verify immutable standards, accepted ADRs, schemas, historical journals and API
baselines against custody evidence. This admission changes no compatibility
baseline or release authority. Full integrated verification and platform
qualification remain coordinator responsibilities; syntax admission and this
bounded type correction do not establish whole-repository conformance.
