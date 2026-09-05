---
id: ADR-0047
status: accepted
supersedes: []
superseded_by: []
primitiveScopes:
  packages/repository-mutation/src/path-identity.ts:
    semantics: Type-only PortablePathIdentity with readonly bigint birthtimeNs, dev and ino,
      and PathIdentityMatch with different, match and missing alternatives. It contains no
      filesystem observation or matching implementation.
    owner: Repository Mutation maintainers; portable observed file identity contract
    rationale: Known-file transactions and generic mutation coordination exchange this
      technical observation value through existing public contracts. Owning it under
      either workflow would introduce a reverse dependency; filesystem observation and
      matching policies remain feature-owned.
    purity: Erased readonly value types only; no runtime state, imports or IO.
      Interoperability preserves bigint fields and the existing public type identity.
    versioning: Same-owner internal caller moves update the profile and tests. Changes to
      semantics, owning responsibility, exact source scope, versioning or consuming
      feature/module identities require a successor ADR and relevant compatibility
      evidence. Existing released API, schema and recovery baselines are not promoted by
      this decision.
    reviewTrigger: Any new consuming identity, source-scope expansion, changed
      ordering/version/identity semantics, ambient operation, exported runtime state or
      drift between the two comparator implementations.
    consumers:
      - document-authoring/document-authoring
      - engineering-foundation/scaffolding
      - engineering-foundation/transaction-coordination
      - repository-mutation/@assembly
      - repository-mutation/known-file-transactions
      - repository-mutation/mutation-coordination
  packages/document-authoring/src/binary-string-comparator.ts:
    semantics: Ordinal raw UTF-16 code-unit string ordering, interoperable with the Foundation
      comparator while retaining canonically equivalent spellings as distinct identifiers.
    owner: Document Authoring maintainers; deterministic document identity ordering
    rationale: Authoring and documentation-observation both require the same ordering. The
      independently published Authoring package cannot import its Foundation consumer;
      retaining this small local implementation avoids a reverse package edge.
      Cross-package fixed vectors guard semantic drift.
    purity: Explicit inputs and deterministic results; no IO, ambient environment or escaping
      module state. Preserve raw ordering or exact version behavior across feature
      consumers; passing finite syntax checks does not prove arbitrary JavaScript purity.
    versioning: Same-owner internal caller moves update the profile and tests. Changes to
      semantics, owning responsibility, exact source scope, versioning or consuming
      feature/module identities require a successor ADR and relevant compatibility
      evidence. Existing released API, schema and recovery baselines are not promoted by
      this decision.
    reviewTrigger: Any new consuming identity, source-scope expansion, changed
      ordering/version/identity semantics, ambient operation, exported runtime state or
      drift between the two comparator implementations.
    consumers:
      - document-authoring/document-authoring
      - document-authoring/documentation-observation
  packages/engineering-foundation/src/binary-string-comparator.ts:
    semantics: Ordinal raw UTF-16 code-unit string ordering and lexicographic string-sequence
      ordering. No locale, Unicode normalization or delimiter-joined identity.
    owner: Engineering Foundation maintainers; deterministic evidence ordering
    rationale: Independent capability owners must produce compatible stable evidence ordering.
      Assigning this algorithm to one of those capabilities would create an unrelated
      feature dependency.
    purity: Explicit inputs and deterministic results; no IO, ambient environment or escaping
      module state. Preserve raw ordering or exact version behavior across feature
      consumers; passing finite syntax checks does not prove arbitrary JavaScript purity.
    versioning: Same-owner internal caller moves update the profile and tests. Changes to
      semantics, owning responsibility, exact source scope, versioning or consuming
      feature/module identities require a successor ADR and relevant compatibility
      evidence. Existing released API, schema and recovery baselines are not promoted by
      this decision.
    reviewTrigger: Any new consuming identity, source-scope expansion, changed
      ordering/version/identity semantics, ambient operation, exported runtime state or
      drift between the two comparator implementations.
    consumers:
      - engineering-foundation/contract-json-schema-releases
      - engineering-foundation/contract-protobuf-evolution
      - engineering-foundation/executable-specifications
      - engineering-foundation/foundation-check
      - engineering-foundation/governance-architecture-decisions
      - engineering-foundation/local-package-mode
      - engineering-foundation/repository-agent-workflow
      - engineering-foundation/repository-security-baseline
      - engineering-foundation/source-dependencies
      - engineering-foundation/suppression-governance
      - engineering-foundation/validation-reporting
      - engineering-foundation/workspace-inventory
  packages/engineering-foundation/src/semantic-version.ts:
    semantics: Exact semantic-version validation, precedence and major/minor/patch
      advancement; arbitrary-precision numeric identifiers, build-metadata-neutral
      precedence and explicitly numbered prerelease-train identity. Not a range resolver
      or release-approval policy.
    owner: Engineering Foundation maintainers; exact version-coordinate semantics
    rationale: Contract evolution, public API, dependency declarations, local mode and
      coordination share exact coordinate interpretation but retain their own
      compatibility and release decisions. None of those workflows owns the others.
    purity: Explicit inputs and deterministic results; no IO, ambient environment or escaping
      module state. Preserve raw ordering or exact version behavior across feature
      consumers; passing finite syntax checks does not prove arbitrary JavaScript purity.
    versioning: Same-owner internal caller moves update the profile and tests. Changes to
      semantics, owning responsibility, exact source scope, versioning or consuming
      feature/module identities require a successor ADR and relevant compatibility
      evidence. Existing released API, schema and recovery baselines are not promoted by
      this decision.
    reviewTrigger: Any new consuming identity, source-scope expansion, changed
      ordering/version/identity semantics, ambient operation, exported runtime state or
      drift between the two comparator implementations.
    consumers:
      - engineering-foundation/contract-json-schema-releases
      - engineering-foundation/contract-protobuf-evolution
      - engineering-foundation/local-package-mode
      - engineering-foundation/public-api-compatibility
      - engineering-foundation/transaction-coordination
      - engineering-foundation/workspace-dependency-declarations
---

# ADR-0047: Exact Ordering, Version and Identity Primitives

Date: 2026-09-05

Decision owner: Repository architecture coordinator, within the authorized
hardening implementation. This is a repository decision, not a claim of an
independent reviewer or additional product-owner sign-off.

## Decision

Admit only the four exact files listed in the frontmatter under the primitive
exception of Feature Module Standard v1. Each file has one stable technical
responsibility shared by the closed consuming identities above. The mutable
[feature profile](../../architecture/foundation/feature-modules.json) names each
current caller path and its actual owner. Imports and type-only re-exports are
observed through the existing source-dependencies parser/resolver and package
surfaces; declarations alone do not qualify a consumer.

This decision supplements ADR-0046 without changing its accepted bytes or the
organization standard. It introduces no shared feature, wildcard permission,
new package, dependency or public export. Existing source-policy restrictions,
feature directions, cycle rejection and finite primitive syntax checks apply.
Application workflows, persistence, recovery and compatibility decisions remain
inside their features. PortablePathIdentity is observed technical data, not a
business entity and not authority to perform a filesystem operation.

Keep the two small comparator implementations in their independently versioned
packages. Foundation consumes Authoring; reversing that dependency to centralize
an ordinal loop would create a package cycle. A separate package has no justified
contract beyond this algorithm. Shared fixed-vector qualification is the current
interoperability contract; the duplication is explicit and bounded.

## Qualification and limits

The admission does not modify the four source implementations. Their reviewed
source SHA-256 values at admission are:

| Exact primitive | SHA-256 |
| --- | --- |
| packages/repository-mutation/src/path-identity.ts | 4488c23a4c36c37e39a1f60aa259fd145dd07992631619be6962ae919201902f |
| packages/document-authoring/src/binary-string-comparator.ts | e15afb4942344ced812b224ee960269bee6c5c63c1ed8708ac99f3ade0e16129 |
| packages/engineering-foundation/src/binary-string-comparator.ts | b3e38b6b09e35ae78df7bebaa89f6050405c20a27232e2aaaf0f67848a504659 |
| packages/engineering-foundation/src/semantic-version.ts | a08f4da4ae74f87046d1f75055be374e2aeff6e841c07f8bbf9d50af6f9a5bc0 |

These fingerprints are review evidence, not a second immutable implementation
baseline. Future implementation edits that preserve semantics use ordinary tests
and review. Semantic or scope changes require a successor decision.

The permanent exact-primitive-contracts suite qualifies both comparators against
raw UTF-16 vectors, including normalization pairs, surrogate code units, embedded
NUL and prefix order. It checks SemVer prerelease precedence, large numeric
identifiers, build metadata and numbered train rejection. The real four source
files must pass the finite primitive checker, and adding Date.now to each must
fail. Existing locale, capability, public type and mutation-boundary suites
provide their separate regression evidence. Feature-module conformance fixtures
retain negative cases for unapproved/stale consumers, ambient/state escapes and
invalid decisions. Whole-repository conformance and release readiness require
their own gates; this admission cannot make those claims.

Canonical JSON and strict JSON in Repository Mutation are explicitly excluded.
Their current implementations are rejected by the finite syntax checker and
need separate semantic and implementation qualification. No fixture decision,
this ADR or the mutable profile grants them a primitive exception. No schema,
persisted recovery bytes or public API fingerprint is accepted by this decision.
