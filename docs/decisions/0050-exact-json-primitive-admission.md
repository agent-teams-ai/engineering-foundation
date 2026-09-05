---
id: ADR-0050
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

# ADR-0050: Exact JSON Primitive Admission

Date: 2026-09-05

Decision owner: Repository architecture coordinator, within the authorized
hardening implementation. This records a repository decision, not independent
reviewer or additional product-owner approval. ADR-0048 and ADR-0049 remain
reserved for the separate schema and Authoring compatibility dispositions.

## Decision

Admit only the two exact source scopes above. The
[feature profile](../../architecture/foundation/feature-modules.json) maps their
41 observed caller paths to the closed feature/module identities. The existing
source-dependencies observer resolves local imports and named workspace-package
surfaces, including type-only exports. No new resolver, broad directory owner,
consumer plugin or generic shared feature is introduced.

This supplements ADR-0046 and ADR-0047. Their accepted bytes remain unchanged.
The latter's exclusion of unqualified JSON sources was correct at that checkpoint;
this decision requires the qualified implementations and bounded grammar below.
Source-policy, exact consumer, layer, cycle and primitive-purity checks remain
mandatory. A passing syntax check alone does not authorize a primitive.

The strict parser now keeps its cursor and recursive scanners inside one validation
invocation. It no longer exposes a module-owned mutable class object or prototype.
The exported scalar error record, native JSON result, duplicate-key precedence and
failure messages remain unchanged. Canonical JSON keeps its hostile-shape checks.
Text hashing uses the complete fixed SHA-256 chain with an explicit UTF-8 update;
it neither depends on locale nor normalizes text. Supported string inputs retain
the same bytes as the previous Buffer conversion.

## Finite operation contract

The primitive grammar adds only:

- Direct zero-argument Set and WeakSet construction within a function invocation.
  Module initialization, constructor aliases/escapes, iterable/spread arguments,
  Map, prototype access and constructor/prototype mutation remain rejected.
- Object.getOwnPropertyDescriptor with exactly two explicit arguments and
  Reflect.ownKeys with exactly one, inside an invocation. Inspection of module
  state or ambient containers, optional/spread calls, callable escapes and unsafe
  reflective writes remain rejected by composed origin/state checks. Explicit
  function inputs retain the reviewed closed-data contract; this is not a proof
  about arbitrary JavaScript proxies or callbacks.
- Object.getPrototypeOf with exactly one explicit argument, used only in strict
  equality/inequality against intrinsic Object/Array prototypes or null. A local
  const may hold the result only when every use is such a comparison in the same
  invocation. Captures, extra aliases, returns, member access and writes fail.
  The intrinsic prototypes themselves are usable only as the other operand of
  those comparisons. General prototype reflection and mutation stay forbidden.

These are bounded syntax and origin rules, not general class admission or an
interprocedural effect system. Semantic review and the normal typed/ambient gates
are still necessary. Do not move feature business policy into these files.

## Compatibility evidence

Before admission, compare against the exact 5f80e17 implementation under Node
24.18.0: 6,157 strict-JSON inputs, 1,038 canonicalization values/errors and 67,584
UTF-8 text hash inputs agree. The hash corpus includes every individual UTF-16
code unit and deterministic mixed strings. Both emitted public declaration files
are byte-identical. This evidence covers supported inputs and explicit hostile
shapes, not arbitrary unsupported JavaScript arguments.

Permanent tests retain golden content-addressed authoring/journal fixtures,
accessor/cycle/shape rejection, public error identity and repeated-call isolation.
The operation matrix initially rejects all eight newly supported controls and
both real JSON implementations; after the bounded changes all 48 selected
positive/negative cases pass. Existing feature guard counterexamples remain
required. The strict-JSON test now follows the actual Mutation public root and
serialization subpath instead of a deleted private Foundation file.

Admission source SHA-256 evidence:

| Exact source | SHA-256 |
| --- | --- |
| packages/repository-mutation/src/canonical-json.ts | 6bbbaf0d170c458c213b8f0d0704793d03211511df5c2bee9a89b1c1f0702dfe |
| packages/repository-mutation/src/strict-json.ts | 05d9d8feb0df6a4d368bfa46c2fa88fc3a51c9304c5354f1745c7c4ac4c924fd |

Fingerprints record the reviewed candidate; they are not an extra implementation
baseline. Same-semantics implementation changes use ordinary review and tests.
No historical schema/journal, accepted ADR or release/API baseline bytes are
rewritten. Final platform, installed-package, registry and seven-consumer
qualification remain separate requirements of the full hardening plan.
