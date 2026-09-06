---
id: ADR-0053
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
      - engineering-foundation/quality-gate-runner
      - engineering-foundation/scaffolding
      - engineering-foundation/transaction-coordination
      - repository-mutation/@assembly
      - repository-mutation/mutation-coordination
---

# ADR-0053: Restoration Strict JSON Consumer Admission

Date: 2026-09-06

Status: Accepted after independent xhigh admission review and historical-schema
closure review at candidate 289be43093a3fb0b9eccd37e402e2ed2e55f1d63.

Decision owner: Repository architecture coordinator. The coordinator authorizes
this bounded admission within the authorized hardening implementation. The
coordinator accepts the reviewed consumer extension; ADR-0050 remains unchanged
and accepted. This does not approve release or consumer rollout.

## Context and decision

New-main restoration proof is untrusted, independently digest-selected evidence.
Its reader must reject ambiguous duplicate decoded keys at every nesting depth
before interpreting closed records. Native JSON parsing alone can silently select
one repeated key. The existing parser supplies the required syntax checks,
duplicate-key precedence and public StrictJsonError identity; a duplicate parser
or provenance-hiding relay would risk different authority interpretations.

Retain both exact primitive scopes and every semantic, ownership, rationale,
purity, versioning, review-trigger and existing consumer identity from
[ADR-0050](0050-exact-json-primitive-admission.md). Add only
`docs-protocol-agent-teams/consumer-integration` to strict-json consumers.
This is a separate admission decision for the expanded strict-json consumer set.
It does not retire ADR-0050: canonical-json still uses that accepted authority.
The complete scope records above retain its contract for the expanded scope. The finite
operation contract and compatibility obligations of ADR-0050 remain in force;
this decision adds no grammar or primitive operation.

The [feature profile](../../architecture/foundation/feature-modules.json) registers
one exact strict-json caller:
`packages/docs-protocol-agent-teams/src/consumer-integration/application/policies/consumer-restoration-proof.ts`.
Only that primitive's decision pointer moves to this admission.
Five exact canonical-json caller registrations remain under ADR-0050's already
admitted consumer identity. Existing caller mappings remain intact.

The restoration caller preserves canonical historical receipt semantics: original
receipts bind exact replacements, while a completing retry reports its observed
already-satisfied outcomes. Preparation selection cannot stand in for successful
activation proof. Kernel APPLYING recovery restores preimages; COMMITTED recovery
only cleans up. No parser, API, wire bytes, digest, error, journal or recovery
implementation changes are authorized here. The separately proposed
[ADR-0052](0052-bounded-managed-v1-restoration.md) retains the restoration lifecycle.

## Compatibility and admission evidence

Qualify the actual proof reader with duplicate literal and decoded keys, nested
objects and arrays, malformed syntax and exact public StrictJsonError behavior.
Retain digest selection before parsing and canonical/closed-shape validation after
parsing. Reuse the authenticated 35/35 restoration fixture evidence and ADR-0050's
primitive semantics corpus for unchanged implementation bytes; do not substitute
new broad E2E runs for this bounded admission check.

Compare both complete scope records mechanically against ADR-0050: the only
metadata change inside primitiveScopes is the one added strict-json identity.
A disposable profile/ADR copy may simulate accepted status to prove that exactly
ten new primitive observations disappear and all 58 base observations remain.
An unauthorized caller must remain rejected. The pre-acceptance proposed source reported its accepted-status rejection
separately; simulation was not treated as approval.

## Acceptance boundary

Independent xhigh review confirmed the admission and the separate historical
schema closure. Final acceptance preserves that reviewed scope; normal baseline
promotion records only this new decision. Accepted ADRs, standards, schemas, released API/recovery baselines and
all guards remain byte-immutable in this patch. No wildcard, broad shared module,
catch-all exception, duplicate parser or guard bypass is introduced. This proposal
does not claim release, real consumer, registry or platform qualification.
