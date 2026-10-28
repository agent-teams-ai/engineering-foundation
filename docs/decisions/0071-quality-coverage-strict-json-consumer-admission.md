---
id: ADR-0071
status: accepted
supersedes: []
superseded_by: []
primitiveScopes:
  packages/repository-mutation/src/canonical-json.ts:
    semantics: "Closed JSON evidence encoding: NFC strings and property names, finite
      safe-integer numbers, dense own-data arrays, plain or null-prototype own-data
      objects, deterministic raw UTF-16 key ordering and explicit SHA-256 byte/text/JSON
      fingerprints. Reject cycles, accessors and unsupported shapes; do not normalize or
      repair inputs."
    owner: Repository Mutation maintainers; canonical evidence encoding and content identity
    rationale: Independent coordination, known-file, authoring and integration owners exchange
      byte-addressed evidence. No consuming workflow owns the shared encoding and hash
      contract; duplicating it risks incompatible journal and receipt identities.
    purity: Explicit data or string inputs; deterministic computation with invocation-local
      working state. No filesystem, clock, environment, network, random operations or
      shared mutable state. The finite checker restricts supported operations and escapes;
      semantic tests still own closed-input and interoperability obligations.
    versioning: Same-owner caller-path moves update the profile and tests. Changed semantics,
      source scope, owning responsibility, consuming identities or versioning require a
      successor ADR and compatibility evidence. Preserve existing released schema,
      recovery and API baselines; this decision does not approve other pending API
      fingerprints.
    reviewTrigger: Any new consuming feature/module, changed canonical bytes or digest,
      changed duplicate/error behavior, expanded runtime input model, ambient operation,
      state/prototype escape or new reflective grammar.
    consumers:
      - docs-protocol-agent-teams/consumer-integration
      - document-authoring/document-authoring
      - engineering-foundation/repository-agent-workflow
      - engineering-foundation/scaffolding
      - engineering-foundation/transaction-coordination
      - repository-mutation/@assembly
      - repository-mutation/known-file-transactions
      - repository-mutation/mutation-coordination
  packages/repository-mutation/src/strict-json.ts:
    semantics: Strict JSON syntax and duplicate decoded-key rejection at every object depth,
      followed by native JSON value parsing. Preserve StrictJsonError identity and
      syntax/duplicate-key failure values. Cursor and key sets belong to one invocation;
      no document, journal or release policy.
    owner: Repository Mutation maintainers; unambiguous JSON input semantics
    rationale: Independent configuration/evidence readers require identical duplicate-key
      handling. Giving one workflow ownership would create reverse feature dependencies,
      while duplicating the parser could accept ambiguous authority evidence.
    purity: Explicit data or string inputs; deterministic computation with invocation-local
      working state. No filesystem, clock, environment, network, random operations or
      shared mutable state. The finite checker restricts supported operations and escapes;
      semantic tests still own closed-input and interoperability obligations.
    versioning: Same-owner caller-path moves update the profile and tests. Changed semantics,
      source scope, owning responsibility, consuming identities or versioning require a
      successor ADR and compatibility evidence. Preserve existing released schema,
      recovery and API baselines; this decision does not approve other pending API
      fingerprints.
    reviewTrigger: Any new consuming feature/module, changed canonical bytes or digest,
      changed duplicate/error behavior, expanded runtime input model, ambient operation,
      state/prototype escape or new reflective grammar.
    consumers:
      - docs-protocol-agent-teams/consumer-integration
      - document-authoring/document-authoring
      - engineering-foundation/contract-json-schema-releases
      - engineering-foundation/executable-specifications
      - engineering-foundation/public-api-compatibility
      - engineering-foundation/quality-coverage
      - engineering-foundation/quality-gate-runner
      - engineering-foundation/scaffolding
      - engineering-foundation/transaction-coordination
      - repository-mutation/@assembly
      - repository-mutation/mutation-coordination
---

# ADR-0071: Quality Coverage Strict JSON Consumer Admission

Date: 2026-10-28

Status: Accepted after independent technical review and bounded admission checks.

Decision owner: Repository architecture coordinator. The coordinator authorizes
this one bounded consumer admission within the full-format coverage delivery.
It does not authorize release, registry rollout or any broader primitive scope.

## Context and decision

Quality coverage reads the consumer's formatter scripts and the installed
stack-toolchain manifest before selecting literal format inputs and validating
its formatter contract. Duplicate decoded JSON keys could give the checker and
the executing tool different authority interpretations. The existing shared
strict parser supplies the required duplicate-key and syntax checks. Native
JSON parsing alone, a duplicate parser or a provenance-hiding relay would not
preserve that contract.

Retain both complete primitive scope records from
[ADR-0053](0053-restoration-strict-json-consumer-admission.md), including every
semantic, owner, rationale, purity, versioning, review trigger and prior consumer.
Add only `engineering-foundation/quality-coverage` to strict-json consumers.
This decision succeeds only ADR-0053's strict-json consumer-set authority; it does
not retire or edit ADR-0053. Canonical-json remains under ADR-0050 unchanged.
The full inherited scope records above add no grammar, operation or parser change.

The [feature profile](../../architecture/foundation/feature-modules.json) moves
only strict-json's decision pointer and registers exactly three current callers:

- `packages/engineering-foundation/src/features/quality-coverage/adapters/consumer-toolchain.ts`
- `packages/engineering-foundation/src/features/quality-coverage/adapters/format-observations.ts`
- `packages/engineering-foundation/src/features/quality-coverage/adapters/format-toolchain.ts`

All three belong to the existing quality-coverage feature and import the public
Repository Mutation serialization surface directly. Same-owner caller-path moves
still require exact profile updates and rejecting checks. A fourth caller is not
admitted merely because it has the same feature owner. No wildcard or feature-wide
path exemption is introduced.

Format observation and command construction stay private typed factories of that
feature. The outer composition file wires imported factories, while the feature
owns active-gate environment interpretation and the returned command callback.
Static capability construction has no authority execution port. The command
borrows the Host-owned process executor through the existing quality-gate command;
cancellation, aggregate budgets, authority ordering and reobservation semantics
remain unchanged. This is fixed composition within one cohesive feature, not a
new independently assembled capability or dynamic lifecycle boundary.

## Compatibility and admission evidence

Mechanical comparison against ADR-0053 verified that the sole primitive scope
metadata delta is the one strict-json consumer identity. The exact profile
comparison retained every prior caller and changed only the decision pointer
plus those three caller records. Accepted predecessor ADRs and primitive
implementation bytes remain unchanged.

The real proposed source rejected accepted-status admission. A disposable copy
then passed the complete ten-module architecture check under simulated accepted
status. Four controls separately rejected removal of an exact caller, removal of
the new consumer identity, proposed status and a fourth direct caller under the
same quality-coverage owner. The production source stayed proposed and unchanged
during those simulations; simulation supplied evidence, not acceptance.

Three selected existing quality-coverage tests passed on admitted Node 26.11.1
after a fresh build and strict TypeScript 7.0.2 checking. Their frozen before/after
binding covered all 52 changed source paths and 132 relevant compiled outputs.
They exercise duplicate literal/decoded keys, malformed JSON and unchanged
StrictJsonError identity, the actual command factory's original budget and
active-gate guard, and real observation byte custody. The name filter selected
three tests and left 26 cases unselected; it does not establish a whole-file,
native, package, release or real-consumer qualification.

## Acceptance boundary

Independent technical review and the repository architecture coordinator's
explicit bounded acceptance authorize only the identity and three exact callers
listed here. Record this decision through the canonical architecture baseline
promoter; never hand-author its evidence or rewrite prior baseline rows.

No accepted predecessor ADR, primitive implementation, released schema/API
baseline, package contract or recovery behavior changes as part of this
admission. Full Linux and native/package qualification remain delivery gates;
this decision does not authorize release or consumer rollout.
