# Agent Architecture Standard implementation plan

Status: Independently reviewed final proposal; implementation has not started
and the plan awaits acceptance of the decision checkpoints

Date: 2026-08-26

Related design study:
[Agent architecture standard design study](agent-architecture-standard-design.md)

## 1. Executive outcome

Build a machine-first open standard that lets coding agents discover a
repository's declared architecture, reason about a proposed change against an
exact snapshot, receive evidence-backed findings, and prove that the integrated
result still satisfies the applicable policy.

The delivery target is a hardened core, reached through a complete 0.x vertical
slice rather than one large platform release. The normative standard remains
language-neutral. Node and TypeScript provide the first reference
implementation. Engineering Foundation provides explicit opt-in integration,
dogfoods the result, and never becomes the source of normative semantics.

The proposed naming system uses working labels until D0 is explicitly accepted:

- **Agent Architecture Standard (AAS)**: the semantic model, profiles,
  evidence rules, compatibility rules, and conformance requirements;
- **Agent Architecture Protocol (AAP)**: the request, response, negotiation,
  and future transport layer inside the broader standard;
- full `agent-architecture-*` identifiers in packages, repositories, schemas,
  commands, and search titles; never bare `aas` or `aap` identifiers.

The complete 0.x vertical slice is expected to add approximately **22,000-33,000
handwritten production and test lines**. The hardened core, Foundation adapter,
and evaluation harness may bring the cumulative total to **34,000-54,000
handwritten lines across repositories** before v1.0. Section 8 owns the single
non-overlapping accounting basis; generated files, normative prose, fixtures,
and consumer changes are reported separately rather than blended into one LOC
claim.

## 2. Success definition

The implementation is successful when an agent can perform this lifecycle with
no hidden mutable state:

```text
open isolated worktree
  -> describe supported standard and profiles
  -> capture an immutable repository snapshot
  -> inspect effective architecture policy and observation coverage
  -> classify explicit planned subjects
  -> evaluate explicit planned relations
  -> validate an exact virtual overlay
  -> apply the change through the normal repository workflow
  -> run affected engineering checks
  -> rebase or integrate
  -> validate the integrated snapshot again
  -> emit a durable evidence receipt
```

The protocol must improve agent behavior without pretending to design the
domain automatically. It can prove declared structural rules, snapshot identity,
observation coverage, and evidence consistency. It cannot prove that bounded
contexts are conceptually correct, that every SOLID principle is satisfied, or
that runtime behavior is safe.

## 3. Delivery principles

1. **Specification first.** Language-neutral schemas, normative prose,
   registries, and conformance vectors define meaning.
2. **Reference implementation second.** TypeScript types and Node behavior are
   replaceable implementations of the standard.
3. **One complete vertical slice.** Do not publish an abstract kernel that has
   no useful agent workflow.
4. **Explicit uncertainty.** Partial observation never becomes a successful
   architecture claim.
5. **Evidence-bound decisions.** Every substantive result identifies the exact
   snapshot, policy, analyzer, profile, and overlay it evaluated.
6. **Repository-native enforcement.** Agents receive convenient commands, while
   hard policy remains enforceable at the integration boundary.
7. **Small extension seams.** Reserve identifiers, version axes, and capability
   negotiation without implementing speculative plugin, transport, registry,
   session, or rule-language platforms.
8. **Consumer-owned semantics.** Projects own their domain vocabulary,
   architecture profile, allowed relations, exceptions, and activation policy.
9. **No surprise activation.** Installing or upgrading Foundation never turns
   on a new rule or hard merge gate.
10. **Measured promotion.** Advisory or shadow results become required only
    after escape and false-block thresholds are demonstrated.

## 4. Decision checkpoints

Implementation must not silently decide the following questions. Each checkpoint
ends in an accepted ADR or an explicit owner decision before dependent code is
merged.

| ID | Decision | Recommended choice | Blocks |
| --- | --- | --- | --- |
| D0 | Public naming | AAS umbrella with AAP as its protocol component | Public package and schema names |
| D1 | Initial repository home | Foundation monorepo with standalone package boundaries; reconsider a neutral repository before v1 | Package scaffolding |
| D2 | Normative artifact authority | Checked-in schemas, registries, prose, and golden vectors; generated TypeScript is derived | Core implementation |
| D3 | Canonical JSON profile | Exact RFC 8785 conformance over a defined I-JSON subset, SHA-256, domain-separated identities | Snapshot and evidence identities |
| D4 | Mandatory secure snapshot profile | Root-relative paths, no symlink following, bounded capture, no execution or network | Node discovery implementation |
| D5 | Initial operation profiles | `classify-subjects@1`, `evaluate-relations@1`, `validate-overlay@1` | Vertical slice |
| D6 | Policy composition | Small immutable modules compile to one effective policy with provenance; adoption presets only select modules and defaults | Operation profiles and UX |
| D7 | First consumer profiles | Consumer-owned Foundation, Orchestrator, and Platform bindings; no shared architecture preset until semantic parity exists | Adoption |
| D8 | Enforcement graduation | A versioned rule-promotion record governs `shadow -> advisory -> limited-required -> required` | Required consumer CI |
| D9 | Public stable-release policy | Stable 0.x packages only after exact tarball qualification; an accepted release ADR must replace the repository's current public RC-wave procedure before omitting `-rc` versions | Publication |
| D10 | Publication DAG and self-host bootstrap | `standard -> reference -> Foundation -> Docs Protocol`; conformance depends only on the standard | Package scaffolding and dogfood |
| D11 | OSS publication authority | Approve license, contribution policy, conduct/security policies, maintainers, release authority, normative change process, namespace ownership, version support, and neutral-repository migration trigger | First public 0.x cohort |

Every checkpoint row is backed by a decision record with `owner`, `approver`,
`evidenceArtifacts[]`, `adrPath`, `decidedAt`, and `mustResolveBeforePr` fields.
The Foundation maintainer prepares evidence; the product owner approves scope,
public naming, publication, enforcement, and governance decisions. PR 0 may
record the decisions but cannot assume them while creating public identifiers.

The plan assumes the recommended choices. D1 blocks public schema identifiers
and the first public package, not only directory scaffolding. D9 preserves the
user-selected no-public-`-rc` policy but does not silently contradict the current
release procedure: publication waits for the explicit release ADR and updated
Changesets qualification. A changed decision requires updating
the affected phases before implementation continues.

## 5. Target repository and package structure

Keep the work in the Engineering Foundation monorepo initially, but make the
standard independently consumable:

```text
packages/
  agent-architecture-standard/
    spec/                 normative prose
    schemas/              normative JSON Schema 2020-12 documents
    registries/           operation, outcome, reason, and extension registries
    vectors/              exact-byte positive and negative conformance data
    generated/            derived language bindings; never authoritative
    scripts/              deterministic validation and generation only
  agent-architecture-reference/
    src/kernel/           only shared protocol and identity value objects
    src/features/
      snapshot-capture/   contracts, use cases, ports, and Node adapters
      classify-subjects/  contracts, use cases, ports, and profile adapters
      evaluate-relations/ contracts, use cases, ports, and profile adapters
      validate-overlay/   contracts, use cases, ports, and virtual adapters
    src/adapters/cli/      machine-first local command adapter
    src/composition/      explicit Node composition root
  agent-architecture-conformance/
    src/runner/           black-box provider runner
    src/oracles/          independently implemented identity checks
    security-corpus/      hostile repository and overlay fixtures
    reports/              schema for portable conformance evidence
  engineering-foundation/
    src/capabilities/<provisional-agent-contract-id>/
                          opt-in Foundation adapter and diagnostics
```

The exact Foundation capability ID is selected during D7. A provisional name
must not leak into published configuration before the activation and ownership
semantics are agreed.

### 5.1 Dependency direction

```text
agent-architecture-standard <- agent-architecture-reference
agent-architecture-standard <- agent-architecture-conformance
agent-architecture-standard <- engineering-foundation
agent-architecture-reference <- engineering-foundation
engineering-foundation <- docs-protocol
agent-architecture-conformance -X-> agent-architecture-reference
```

Conformance launches providers out of process using manifests and envelopes from
the standard package. It has no production import from the reference package,
including public helpers or generated runtime codecs. Features in the reference
package may depend on the standard and the deliberately small kernel, never on
another feature's application layer.

Forbidden dependencies:

- the standard package importing Node, Foundation, consumer code, or a parser;
- the reference package importing Foundation capabilities;
- the conformance runner importing any reference implementation production code;
- product/runtime code importing Foundation solely to execute the standard;
- normative schemas being generated from handwritten TypeScript types;
- consumer domain names or bounded-context catalogs entering any core package.

### 5.2 SOLID and Clean Architecture mapping

| Principle | Concrete boundary |
| --- | --- |
| SRP | Specification, identity/canonicalization, each operation feature, CLI, conformance, and Foundation adoption remain separate change actors |
| OCP | New operations and vocabularies use namespaced, independently versioned profiles rather than central enum edits |
| LSP | Providers are substitutable only when they advertise and satisfy the same operation, evaluator, vocabulary, limits, and conformance profile |
| ISP | Providers implement small capability profiles; no universal analyzer interface or empty methods |
| DIP | Operation use cases own ports; Node filesystem, hashing, clock, and parser details are outbound adapters |
| Clean Architecture | Normative model and pure policies point inward; CLI, filesystem, Git, Foundation, and future transports point inward through public boundaries |
| DDD | Protocol negotiation, repository observation, profile-owned evaluation, and overlay validation are explicit bounded contexts; snapshot and evidence identities are shared-kernel values, while consumer vocabularies remain external bounded contexts |

## 6. Normative v0.x contract

### 6.1 Version axes

Keep these compatibility versions independent:

- standard version;
- encoding and canonicalization version;
- protocol envelope version;
- operation profile version;
- vocabulary and evaluator profile version;
- envelope version;
- operation and profile version.

A new operation or vocabulary must not require a standard major release. A
change to identity-bearing canonicalization, required fields, defaults, or
existing semantic meaning requires a major version.

Provider, analyzer, conformance-suite, and extension-local versions remain
evidence metadata rather than global compatibility axes. Once published, an
envelope schema is immutable. Peers advertise supported envelope versions and
emit exactly the deterministic mutually selected version. No overlap produces a
bootstrap version problem; silent downgrade is forbidden. Conformance includes
an old-reader/new-writer matrix, new-reader/old-writer matrix, unknown extension,
and no-common-version cases.

### 6.2 Envelope families

Define separate closed core schemas for:

- provider description and capability negotiation;
- request envelopes and per-target inputs;
- result envelopes and per-target resolutions;
- problem envelopes for malformed requests, version mismatch, limits, and
  provider faults;
- immutable artifact and snapshot descriptors;
- evidence bundles and coverage reports;
- overlay declarations and validation receipts;
- conformance manifests and reports.

Core schemas reject unknown fields. Extensibility exists only through bounded,
namespaced `extensions` and `criticalExtensions` maps at explicitly listed
envelope and target locations. Identifiers use one documented reverse-DNS or URI
syntax; duplicate identifiers fail decoding. Every semantics-affecting extension
is critical. An unknown envelope-level critical extension is a request problem;
an unknown target-local critical extension resolves that target as
`unsupported`. Results record whether each noncritical extension was understood,
preserved, or ignored. Request identity includes both maps; the analysis key also
includes every understood semantics-affecting extension. No competing
`mustUnderstand` representation is introduced.

### 6.3 Resolution model

An invalid envelope or duplicate/malformed target identifier produces one
request problem and no result envelope. Once request validation succeeds, every
unique requested target receives exactly one resolution:

- `decided`;
- `needs-input`;
- `indeterminate`;
- `unsupported`;
- `stale`.

Evaluation profiles place `pass`, `fail`, or `not-applicable` inside a `decided`
resolution. Incomplete observation is `indeterminate` with a registered
`observation-incomplete` reason. Invalid budget declarations and provider-wide
faults use the problem model; valid per-target execution that exhausts a budget
returns `indeterminate` with terminal coverage and limit evidence. Cancellation
semantics state whether the entire request failed before acceptance or which
accepted targets reached a terminal resolution. Mixed-batch, duplicate-ID,
malformed-target, cancellation, partial-exhaustion, and provider-failure vectors
are mandatory.

### 6.4 Identity model

Keep distinct identities for:

- artifact bytes;
- immutable repository snapshot and declared coverage;
- policy and profile content;
- analyzer implementation/configuration;
- planned overlay;
- operation request;
- analysis key;
- result payload;
- integrated-state validation receipt.

Identity-bearing JSON conforms exactly to the selected RFC 8785 and I-JSON
subset. It uses safe signed integers; larger quantities are canonical decimal
strings. Non-path strings receive no Unicode normalization. Portable paths use
their own versioned algorithm and reject rather than silently normalize an input.
Duplicate keys, lone surrogates, invalid UTF-8, non-finite numbers, negative
zero, and unsupported number spellings fail before identity production.
Absolute paths, timestamps, inode numbers, user IDs, environment values, and
machine-local roots never affect portable identities.

Before Phase 2 implementation, add a normative identity table for every identity
above. Each row defines its domain tag, canonicalization version, included and
excluded fields, inline-versus-reference framing, algorithm, and whether
repository, base revision, worktree/integration state, budgets, coverage,
extensions, or configuration participate. A digest field is always excluded
from the body it digests. Exact-byte vectors cover numeric boundaries, Unicode,
object ordering, path collisions, self-reference, and domain-separator attacks.

### 6.5 Coverage and evidence

Coverage reports the declared denominator and terminal state for discovery,
capture, classification, evaluation, and overlay reevaluation. Included,
policy-excluded, unreadable, unsupported, unstable, unknown, and
budget-exhausted units remain distinguishable.

Evidence identifies immutable content, byte range or structured pointer,
producer, derivation, sensitivity, input digest, and applicable rule/profile.
The implementation verifies referential consistency where possible but never
claims that a self-asserted provider identity proves trust or truth. Evidence
assurance uses orthogonal fields:

- `integrityStatus`: `unresolved`, `digest-matched`, or `snapshot-bound`;
- `producerAssurance`: `self-asserted`, `policy-allowlisted`, or
  `externally-attested`;
- `semanticStatus`: `unchecked`, `schema-valid`, or `conformance-checked`.

Portable receipts exclude snippets, absolute paths, environment data,
configuration secrets, and provider prose. Detailed root-relative paths are
treated as sensitive local metadata; redacted exports are derived artifacts
bound to the original result digest.

### 6.6 Policy modules, bindings, and effective configuration

Projects configure architecture through small immutable data modules rather than
one universal preset or a generic merge language:

- a **vocabulary module** names consumer concepts;
- an **evaluator module** owns typed relation or structural semantics;
- a **policy module** selects rules, severity, and bounded parameters;
- an **adoption preset** selects a reviewed set of modules and defaults but
  creates no new rule semantics;
- a **consumer binding** applies exact module IDs and digests to an explicit
  scope and enforcement mode.

The closed binding schema supports multiple named scopes, exact profile and
policy digests, budgets, `shadow | advisory | limited-required | required` mode,
and governed exceptions with rule ID, bounded scope, owner, reason, and expiry.
Repository documents can select only statically registered identifiers. They
cannot contain module specifiers, commands, arguments, environment lookups,
dynamic imports, package paths, executable callbacks, URLs, or arbitrary code.

Composition compiles an acyclic list of exact modules into one immutable
effective policy. There is no generic deep merge or implicit array replacement.
Duplicate definitions and overlapping bindings fail closed unless an explicit,
schema-owned override names the exact rule/field and expected prior module
digest. The compiler emits flattened modules, layer order, winning and
overridden values, conflicts, exceptions, source provenance, and an effective
policy digest. `inspect` and every result expose the selected binding and digest;
`explain` can show why a value won.

Installing a package or a newer preset never changes an existing binding.
Consumers opt into a new exact module or preset version in a reviewed change.
A shared module enters Foundation only after two real consumers demonstrate the
same semantics, parity fixtures exist, and superseded consumer code is removed.

### 6.7 Profile manifests and normative budgets

Every operation, vocabulary, and evaluator profile has an immutable manifest
containing a namespaced ID, version, content digest, operation ID, input/result
schema digests, required profile dependencies, critical extensions, deterministic
limits, and conformance claim. Selection uses exact ID and digest; SemVer alone
never implies semantic substitutability.

Protocol substitutability and evaluator substitutability are distinct. For one
profile digest, the specification identifies identity-sensitive fields,
permitted output variance, ordering, limit behavior, and mandatory vector
outcomes. An advertised profile must pass its entire corpus and cannot return
`unsupported` for valid in-profile input.

Core registries contain only reserved identifiers. External operations,
profiles, reasons, and findings remain namespaced, digest-bound, profile-owned
data and do not require central registry edits. Additional generic registry
machinery requires a second independent profile family with the same need.

Every profile defines checked-in ceilings and accounting units for encoded input
bytes, nesting, paths, segments, entries, logical and read bytes, per-entry
bytes, overlay operations, requested targets, evidence references, extension
bytes, diagnostics, output bytes, concurrency, and total work. Aggregate budgets
cannot reset per target or extension. Allocation-before-validation, integer
overflow, sparse files, repeated references, diagnostic amplification, and
cancellation receive negative vectors. Deterministic counters are
identity-bearing; elapsed deadlines and external cancellation are reported
separately and cannot yield partial success.

## 7. Workstreams

The phases below are ordered by evidence dependency. Independent work inside a
phase may run in parallel in isolated worktrees with non-overlapping ownership.

| Workstream | Ownership | May run in parallel with |
| --- | --- | --- |
| A. Specification and registries | Normative artifacts and compatibility | Security corpus, documentation examples |
| B. Canonicalization and identities | Pure reference implementation | CLI shell after public interfaces freeze |
| C. Secure Node snapshot | Filesystem ports and adapters | Operation-profile schema work |
| D. Operation profiles | Classification, relation evaluation, overlay | Snapshot adapter after snapshot contract freezes |
| E. Conformance and security | Independent runner and hostile corpus | Reference implementation; no shared oracle code |
| F. Agent UX and Foundation adoption | CLI, diagnostics, capability adapter | Evals after stable JSON output exists |
| G. Consumer adoption and evals | Sandbox fixtures, real opt-in consumers, metrics | Release qualification |
| H. Release engineering | Packages, provenance, compatibility | Documentation and adoption evidence |

No two workers edit the same package or generated artifact concurrently.
Generated files are produced only by the owning integration step.

# Phase 0 - Freeze scope, threat model, and authority

## Summary

Turn the research direction into accepted, reviewable contracts before writing
runtime code.

## Detailed implementation steps

1. Accept or amend D0-D11.
2. Add an ADR for the standard/reference/Foundation authority split.
3. Add an ADR for identity and canonicalization authority.
4. Publish a glossary for snapshot, artifact, subject, relation, profile,
   analyzer, evidence, coverage, overlay, resolution, problem, and receipt.
5. Publish the v0.x compatibility policy and experimental-extension rules.
6. Publish the malicious repository/config/analyzer threat model. Distinguish
   static malicious state, cooperative concurrent mutation, and a hostile
   same-OS-user process. Portable Node prevents traversal in static state and
   rejects observed drift, but does not claim confidentiality against an
   undetectable same-user ancestor-swap race. Stronger guarantees require
   handle-relative no-follow traversal or a host sandbox and otherwise report
   `unsupported`.
7. Record the deferred-feature register and explicit admission triggers.
8. Define the first two consumer scenarios and the disposable eval repositories.
9. Accept D11 before public 0.x: SPDX license, contribution/DCO-or-CLA policy,
   Code of Conduct, SECURITY policy, maintainer and release authority,
   normative-change process, namespace/domain/trademark ownership, supported
   versions, and neutral-repository migration trigger. Do not claim an
   independent foundation or certification program.
10. Decide the publication DAG and bootstrap sequence from D10, including how a
    broken dogfood rule can be rebuilt without invoking itself.
11. Define repository-controlled configuration as closed inert data that may
    select only statically registered identifiers. Operator-selected external
    providers live outside repository authority and require independent
    allowlisting of immutable artifact and configuration digests.

## Risks and edge cases

- AAS acronym collision and package/domain availability.
- Normative prose contradicting schemas or vectors.
- Foundation internals becoming de facto standard behavior.
- Consumer examples accidentally becoming universal domain semantics.
- Scope expanding to plugin loading, transports, sessions, or a Rule DSL.
- Public 0.x schema identifiers binding authority to the Foundation repository
  before D1 defines namespace ownership, relocation, and preservation.

## Tests and verification

- documentation reference and ADR checks;
- glossary term consistency scan;
- schema/spec/vector authority table reviewed by two people;
- package, domain, repository, and trademark collision evidence recorded before
  public branding.
- release DAG and clean-bootstrap drill that builds without the new dogfood gate,
  then dogfoods built artifacts, then qualifies packed artifacts in isolation.

## Rollback

No runtime or consumer behavior changes. Revert the proposed ADRs before they
are accepted, or supersede accepted ADRs explicitly.

## Acceptance criteria

- D0-D11 have explicit outcomes;
- ownership, trust boundaries, non-goals, and compatibility are unambiguous;
- no implementation depends on an unresolved identity question.

Approximate change: **1,200-2,000 lines of specification and ADRs**.

# Phase 1 - Create normative artifacts and deterministic generation

## Summary

Create the standalone standard package and prove that generated bindings cannot
silently redefine it.

## Detailed implementation steps

1. Scaffold `agent-architecture-standard` with normative prose, JSON schemas,
   registries, vectors, and a machine-readable artifact manifest.
2. Define schema IDs and stable local reference resolution with no network
   access during validation.
3. Add strict JSON parsing rules: duplicate-key rejection, depth/size limits,
   safe object construction, and deterministic diagnostics.
4. Generate TypeScript declaration types from schemas into `generated/`.
5. Add a drift gate proving every public schema, registry, and generated type is
   indexed exactly once.
6. Add a reproducibility gate: a clean regeneration produces no diff.
7. Pack the standard artifact and verify that every normative file and vector is
   present with stable relative paths.
8. Add a public manifest mapping standard version to schema, registry, and
   vector digests.

## Risks and edge cases

- circular schema references;
- multiple copies of the same schema ID;
- generated types weakening schema constraints;
- network `$ref` resolution;
- packaging omitting fixtures or rewriting line endings;
- Windows path and case behavior changing manifest identities.

## Tests and verification

- positive and negative schema corpus;
- duplicate and unknown schema ID tests;
- generation idempotence on Linux, macOS, and Windows;
- exact tarball inventory and install test;
- public API and package-boundary checks;
- `check:changed`, fast gates, and package qualification.

## Rollback

The new package remains unpublished and unreferenced by Foundation until its
artifact manifest is reproducible.

## Acceptance criteria

- normative artifacts can be consumed without Node runtime code;
- schema and registry drift is impossible without a failing gate;
- packed artifacts reproduce the checked-in manifest.

Approximate change: **2,000-3,500 lines including tests**.

# Phase 2 - Implement canonicalization, identity, and result kernel

## Summary

Implement the pure reference kernel with no filesystem, process, network, or
Foundation dependency.

## Detailed implementation steps

1. Implement bounded strict decoding into immutable domain values.
2. Implement canonical encoding and domain-separated SHA-256 identities.
3. Implement version and capability negotiation.
4. Implement closed core outcomes, problems, extension criticality, and exact
   per-target reconciliation.
5. Implement snapshot, policy, analyzer, overlay, request, analysis, result, and
   receipt identity constructors as separate modules.
6. Implement coverage reconciliation that cannot emit complete when a relevant
   unit lacks a terminal covered state.
7. Implement evidence reference validation without claiming producer trust.
8. Expose small public interfaces for description and invocation; keep storage,
   transport, caching, and plugin discovery absent.
9. Write a second test-only canonicalizer or import independently produced
   golden bytes without sharing production identity code.
10. Implement the normative identity table and version-negotiation matrix from
    Section 6, including historical decoding and profile withdrawal behavior.

## Risks and edge cases

- Unicode normalization collisions;
- negative zero, floating point, oversized integers, and exponent notation;
- extension data affecting identities inconsistently;
- ambiguous optional-field defaults;
- plural operation results dropping or duplicating targets;
- `unsupported` being mistaken for a provider failure;
- identity reuse across different semantic domains.

## Tests and verification

- exact-byte golden vectors;
- property tests for encode/decode stability and target reconciliation;
- mutation tests for every identity input;
- unknown optional and critical extension tests;
- unsupported-version and safe-downgrade tests;
- cross-platform deterministic digest tests;
- independently produced oracle comparison.

## Rollback

No adapter or consumer depends on the kernel until golden vectors pass in two
independent implementations.

## Acceptance criteria

- identical documents produce identical bytes and digests everywhere;
- every semantics-affecting mutation changes the appropriate identity;
- faults, uncertainty, and verdicts remain distinct;
- the kernel has no Node or Foundation imports.

Approximate change: **3,000-4,500 lines including tests**.

# Phase 3 - Build secure repository snapshot capture

## Summary

Build the first Node adapter that turns an explicitly supplied repository root
and capture profile into an immutable snapshot without executing repository
content.

## Detailed implementation steps

1. Define application-owned ports for traversal, stable file reads, hashing,
   cancellation, budgets, and monotonic timing.
2. Implement portable root-relative path normalization and collision detection.
3. Implement bounded traversal that rejects escape, symlinks, junctions,
   reparse points, devices, sockets, FIFOs, unsafe encodings, and forbidden link
   behavior. Relevant regular files with an observable link count other than one
   are unsupported in the mandatory secure profile.
4. Open terminal files no-follow where supported, verify the opened handle, and
   compare identity, type, size, mode, and link count before and after hashing.
   Revalidate root ancestry and discard all bytes/evidence on observed drift.
5. Represent unreadable, unstable, unsupported, excluded, and exhausted entries
   explicitly in coverage.
6. Build immutable manifest ordering and snapshot identity generation.
7. Add disclosure policy so file content and snippets remain absent by default.
8. Add cancellation and deterministic resource-limit outcomes.
9. Make platform limitations explicit: return `unsupported` or `indeterminate`
   rather than silently weakening the secure profile.
10. Implement `portable-path@1`: fatal host-name decoding to Unicode scalar
    values; pinned NFC and default-case-fold data; rejection of normalization and
    portability collisions, absolute/UNC/drive/device paths, backslashes, NUL,
    controls/bidi, dot segments, trailing dot/space, and reserved segments. An
    accepted path is never silently rewritten.

## Risks and edge cases

- symlink swaps and TOCTOU races;
- hard links, case-insensitive collisions, Unicode aliases, and changing files;
- nested repositories and submodules;
- ignored files versus policy-excluded files;
- huge trees, sparse files, and permission changes;
- Windows reserved names and separator behavior;
- cancellation after partial capture.
- hostile same-user ancestor swaps that portable Node cannot make
  identity-fenced; these are an explicit profile limitation, not a passed test.

## Tests and verification

- hostile filesystem corpus using disposable test directories only;
- bounded race tests and deterministic instability outcomes;
- property tests for path normalization;
- memory, file-size, entry-count, time, and cancellation budgets;
- Linux, macOS, and Windows parity fixtures;
- proof that no subprocess, hook, install, network, or target write occurs.

## Rollback

Keep the adapter behind an unpublished composition root. If a platform cannot
meet the secure profile, mark that platform unsupported rather than adding a
weaker implicit mode.

## Acceptance criteria

- no static-state root escape or target mutation in the accepted adversarial
  corpus, with observed concurrent drift rejected and the same-user race limit
  documented honestly;
- incomplete capture cannot produce complete coverage;
- identical captured content and profile produce identical snapshots;
- privacy defaults disclose only root-relative metadata and digests.

Approximate change: **3,500-5,000 lines including tests**.

# Phase 4 - Implement the three operation profiles

## Summary

Deliver the useful architecture-analysis vertical slice without introducing a
universal ontology or Rule DSL.

## Detailed implementation steps

1. Define `classify-subjects@1` schema and semantics for explicit subject
   references, named vocabulary profiles, evidence, confidence scale, and
   unknown classifications.
2. Define `evaluate-relations@1` for explicit role-named relation candidates,
   evaluator profiles, planned/observed separation, findings, and evidence.
3. Define `validate-overlay@1` for bounded add/replace/delete operations,
   required base snapshot, per-path preconditions, virtual atomic application,
   prospective snapshot, and reevaluation coverage.
4. Implement each operation behind its own narrow application port and use case.
5. Keep vocabulary and evaluator logic in explicit profile modules, not core
   switches.
6. Add a small demonstrative neutral profile for conformance; do not label it a
   universal DDD/Clean/FSD profile.
7. Produce stable diagnostic codes and machine-actionable remediation data.
8. Bind every resolution to the exact operation, profile, snapshot, policy,
   analyzer, and overlay identities.
9. Implement the effective-policy compiler from Section 6.6 with exact module
   manifests, ambiguity rejection, override provenance, and deterministic
   effective-policy identity.

## Risks and edge cases

- paths treated as universal subject IDs;
- planned relations leaking into observed state;
- a global result hiding mixed per-target outcomes;
- overlay rename/case/line-ending ambiguity;
- stale base or precondition accepted partially;
- generic confidence values without defined scale;
- evaluators advertised as substitutable without shared fixtures.
- preset/module cycles, ambiguous scoped bindings, expired exceptions, and
  overrides that do not match the expected prior digest.

## Tests and verification

- profile-level positive, negative, unknown, stale, and unsupported fixtures;
- one resolution per target property;
- planned versus observed isolation tests;
- overlay atomicity and stale-precondition tests;
- mutation and property testing for virtual overlay application;
- diagnostic stability and bounded-message tests;
- conformance fixtures authored separately from production code.
- effective-policy golden fixtures covering composition order, conflicts,
  provenance, explicit overrides, upgrades, downgrades, and no activation after
  package-only changes;
- hostile inert-config fixtures for module/package paths, commands, `file:` and
  HTTP URLs, YAML tags/aliases, prototype keys, environment interpolation,
  symlinked profile paths, and unknown static identifiers.

## Rollback

Each profile is independently versioned and can remain experimental. Do not
promote its conformance claim if semantics are ambiguous or fixtures depend on
reference implementation quirks.

## Acceptance criteria

- adding a profile does not modify the core envelope;
- exact overlays never write to the target repository;
- a stale or partially observed input cannot produce an exact pass;
- profile behavior is implementable from public documents and fixtures.

Approximate change: **4,000-6,000 lines including tests**.

# Phase 5 - Deliver machine-first CLI and agent UX

## Summary

Make the vertical slice easy for coding agents to use locally while keeping
semantics independent of prompts and transports.

## Detailed implementation steps

1. Add `describe`, `inspect`, `policy effective`, `classify`, `evaluate`,
   `overlay validate`, and `explain` commands over the public provider boundary.
2. Make stable JSON the primary contract, with uncontaminated stdout,
   deterministic ordering, documented exit codes, and logs on stderr.
3. Support explicit `--root`, profile, policy, snapshot, overlay, budget, and
   output inputs; do not guess architecture from folder names.
4. Add concise human rendering as a projection of the same result.
5. Add `--dry-run`, evidence references, omissions, coverage, and remediation
   output.
6. Emit one compact architecture receipt agents can retain and expand by stable
   reference.
7. Add effective-instructions guidance that tells agents when to invoke the
   lifecycle, without injecting repository evidence into instruction channels.
8. Define the integrated-state validation command separately from pre-write
   overlay validation.
9. Add one canonical read-only `workflow` entrypoint that returns
   `requiredSteps[]` and `nextActions[]`. Every step has a stable ID, required
   inputs, argv-array invocation, freshness dependencies, outcome, and
   `completed | skipped | not-applicable` status with a reason code. It may
   orchestrate analysis but never writes repository content.
10. Define a mandatory non-truncatable header containing resolution, outcome,
    snapshot/profile/policy/analyzer/overlay identities, freshness, coverage,
    severity counts, omissions, and next required action. If the header exceeds
    the declared budget, return a resource problem.
11. Add deterministic stateless pagination with a cursor bound to result digest,
    request, profile, and position. Expansion recomputes from the exact request
    or reads an explicit caller-owned receipt; it never relies on hidden session
    or cache state.
12. Add a normative freshness matrix covering base revision, worktree and
    integration state, snapshot, policy, effective configuration, profile,
    analyzer, observation index, overlay, request, and relevant budgets.
13. Give every resolution a bounded `decisionTrace`: effective binding,
    rule/profile version, normalized facts, evidence references, evaluated
    branch, terminal reason, and remediation preconditions. Support
    `explain --result <digest> --target <id>` as well as static rule metadata.
14. Type repository/provider strings as untrusted data. Stable remediation
    actions come only from trusted profile data and a closed action schema. Text
    rendering visibly escapes terminal controls, OSC links, bidi controls, and
    invalid Unicode and never interprets Markdown or repository prose as
    instructions.

## Risks and edge cases

- agents skipping optional commands;
- JSON output polluted by progress logs;
- implicit current directory selecting the wrong repository;
- context windows truncating critical omissions;
- receipts reused after rebase or policy change;
- explanations showing untrusted source content as instructions;
- CLI conveniences becoming undocumented protocol semantics.
- forged remediation, ANSI/OSC output, bidi filename spoofing, stale cursors,
  and high-severity findings appearing beyond the first page.

## Tests and verification

- command contract and exit-code fixtures;
- stdout/stderr separation tests;
- wrong-root, missing-input, stale-receipt, cancellation, and partial-output
  cases;
- large diagnostic-set truncation with explicit omission metadata;
- packed CLI install tests on supported platforms;
- agent-readable JSON snapshots and human-render parity tests.
- required-step skip accounting; missing tool, retry, cancellation, wrong-root,
  reorder, and stale-intermediate receipt cases;
- freshness-matrix mutation tests, pagination stability, non-truncatable header,
  decision-trace parity, and prompt/terminal injection fixtures.

## Rollback

CLI commands remain additive and experimental during 0.x. Hard policy does not
depend on agent invocation; the integration verifier remains authoritative.

## Acceptance criteria

- a fresh repository produces useful bounded output in one command;
- every hidden assumption is explicit in JSON identities or coverage;
- agents can determine whether a result is current without prose interpretation;
- no prompt, model, daemon, or network service is required.
- an unexplained skipped required step is visible and fails sandbox evals, while
  the integration verifier remains authoritative even if the workflow was never
  invoked.

Approximate change: **2,000-3,000 lines including tests**.

# Phase 6 - Build independent conformance and security evidence

## Summary

Prove the contract independently enough that the reference implementation
cannot merely test its own mistakes.

## Detailed implementation steps

1. Build a black-box conformance runner that uses only `describe` and `invoke`
   provider boundaries.
2. Define claimable profiles: core data/canonicalization, snapshot, operations,
   overlay, and full vertical slice.
3. Build an independently authored canonicalization oracle and exact-byte
   vectors.
4. Add hostile JSON, path, filesystem, evidence, extension, overlay, and budget
   corpora.
5. Add fuzz and property campaigns with deterministic replay artifacts.
6. Add provider honesty tests: advertised profiles must accept valid in-profile
   requests or report a conformance failure.
7. Add portable conformance reports bound to suite and provider digests.
8. Run Linux, macOS, and Windows jobs in parallel; shard tests by independent
   fixture families while keeping race-sensitive filesystem tests isolated.
9. Audit the independent oracle's dependency graph and implementation lineage.
   It may consume only normative schemas and vectors, not reference bindings,
   generated runtime codecs, or transitive production canonicalizers. Use
   separate review ownership and preferably a second implementation language.
10. Seed deliberately nonconforming providers and canonicalizer defects to prove
    that the runner detects disagreement, rather than merely replaying fixtures.
11. Add cross-provider interoperability, cross-version negotiation, old-receipt
    decoding, profile replacement, and profile-withdrawal cases.

## Risks and edge cases

- shared production/oracle code making false agreement;
- a validator that blocks everything appearing safe;
- nondeterministic fuzz failures without replay seeds;
- Windows filesystem behavior dominating feedback time;
- optional security tests being skipped as unsupported;
- conformance being mistaken for analyzer trustworthiness.
- two implementations sharing the same generated runtime codec or transitive
  canonicalizer while being labelled independent.

## Tests and verification

- clean controls as well as hostile cases;
- every `MUST` linked to at least one positive and one negative vector;
- deterministic replay for all fuzz/property failures;
- no network and no target-repository scripts during conformance;
- package qualification and independent consumer harness.

## Rollback

Conformance claims remain scoped by profile. A failing profile is removed from
the claim, not weakened silently. Identity disagreements block release.

## Acceptance criteria

- no identity disagreement between independent oracles;
- mandatory security cases cannot be skipped;
- reports identify exact suite, provider, profile, and artifact digests;
- clean-change false positives are measured, not ignored.

Approximate change: **3,000-4,500 lines including tests and corpus harnesses**.

# Phase 7 - Integrate as an opt-in Foundation capability

## Summary

Connect the standard to Engineering Foundation without coupling the standard to
Foundation or automatically activating consumer policy.

## Detailed implementation steps

1. Select the capability ID and configuration schema through D7.
2. Add one feature-owned capability slice with its own contract, application,
   adapters, fixtures, schema, and diagnostics.
3. Accept the closed consumer-binding schema from Section 6.6: multiple named
   scopes, exact profile/module/policy digests, budgets, enforcement mode,
   governed expiring exceptions, and optional baseline evidence.
4. Translate Foundation configuration into public standard documents.
5. Invoke the reference provider only through the public boundary.
6. Validate integrated repository state in static checks; keep agent planning
   commands separate from static capability execution.
7. Add stable Foundation finding codes that retain underlying standard evidence
   and identities.
8. Register schema, capability, rule, explain, and documentation IDs with drift
   invariants.
9. Add changed-scope routing without allowing it to substitute for complete
   required CI coverage.
10. Dogfood the capability in Foundation with Foundation-owned architecture
    facts and no consumer business concepts in reusable packages.
11. Implement the D10 bootstrap in three stages: build without invoking the new
    capability; dogfood the freshly built provider and adapter; qualify packed
    artifacts in an isolated consumer. A failed dogfood rule cannot prevent
    rebuilding its checker, and no published Foundation manifest depends on
    Foundation itself.
12. Keep the existing source-dependency capability authoritative until an
    explicit parity matrix, migration, and rollback decision accepts replacement
    or coexistence.
13. Before any authority switch, dual-run advisory results against the existing
    capability, compare normalized findings rather than rendered messages,
    assign every mismatch, prove parity fixtures in two consumers, merge a
    dedicated authority-switch PR, retain the old implementation as an oracle
    for a bounded observation window, and delete only demonstrably superseded
    rules. Cover old config, old receipt, upgrade, downgrade, and rollback paths.

## Risks and edge cases

- cyclic product dependency on Foundation;
- duplicated schema or diagnostic semantics;
- static `check` unexpectedly executing analysis scripts;
- capability activation after an ordinary package upgrade;
- Foundation profile being presented as universal;
- existing source-dependency capability and new relation evaluation disagreeing.
- ambiguous scoped bindings, environment interpolation, executable config,
  symlinked policy/profile paths, or expired exception evidence.

## Tests and verification

- activation and non-activation fixtures;
- schema/runtime/explain/rule registry parity;
- Foundation dogfood fixture and exact integrated-state receipt;
- package dependency direction and public API checks;
- upgrade/downgrade tests proving old consumers remain inactive;
- parity comparison with existing source-dependency findings where scopes
  overlap.
- clean-bootstrap, built-artifact dogfood, packed-consumer qualification, and
  broken-checker rebuild drills;
- dual-run normalized parity, mismatch stop conditions, authority switch,
  retained-oracle window, old-config, old-receipt, and deletion evidence.

## Rollback

The capability is opt-in and removable from consumer configuration. The single
configuration-level rollback is capability removal or an explicit rule-pack
mode transition; no `enabled: false` placeholder is introduced. Keep the
existing source-dependency capability authoritative until parity and migration
are explicitly accepted.

## Acceptance criteria

- Foundation uses the public standard boundary against itself;
- consumers remain owners of activation, vocabulary, policy, and exceptions;
- installation alone changes no check result;
- no standard package imports Foundation.

Approximate change: **2,000-3,500 lines including tests**.

# Phase 7.5 - Publish a qualified experimental 0.x cohort

## Summary

Create the exact published pins required for real consumer adoption. This is a
stable-numbered but explicitly experimental 0.x cohort, not the hardened v1
candidate and not a public prerelease suffix.

## Detailed implementation steps

1. Accept D9-D11 and extend the existing ordered publisher for the new package
   graph.
2. Keep candidate tarballs private. Run a generated release PR through complete
   exact-head CI and inspect its immutable packed artifacts.
3. Publish only numeric experimental 0.x versions in topological order:
   `standard -> reference -> Foundation -> Docs Protocol`, with conformance
   independently versioned after the standard and before any external claim.
4. Preserve the existing paired Foundation/Docs release invariant unless D10's
   ADR explicitly changes it.
5. Produce SRI, provenance, SBOM, package inventory, exact dependency pins,
   registry-install evidence, and an external Qualified Cohort record.
6. Prove install, upgrade, downgrade, public API, and rollback against disposable
   consumers before admitting Orchestrator or Platform.
7. Record every cohort member and digest in one immutable release manifest.

## Risks and edge cases

- publishing before D9 updates the current RC-capable Changesets workflow;
- Foundation/Docs version skew;
- conformance package accidentally depending on reference implementation;
- unpublished workspace links leaking into consumer PRs;
- partial publication leaving an unusable cohort.

## Tests and verification

- generated release PR and complete exact-head required CI;
- topological dry run and partial-failure recovery rehearsal;
- exact tarball, SRI, provenance, registry, upgrade, downgrade, and external
  consumer qualification;
- immutable-version rule: no unpublish, overwrite, or ad hoc dist-tag repair.

## Rollback

Do not admit consumers until the entire cohort is qualified. After publication,
fix forward with a new stable numeric version and let consumers remain on the
last-known-good exact pin.

## Acceptance criteria

- every real consumer can install exact public versions without local links;
- all published members have one qualified cohort manifest;
- the release procedure, package DAG, and no-public-`-rc` rule agree;
- Phase 9 is a hardened successor release, not the first consumable release.

Approximate change: **1,500-2,500 handwritten lines plus release evidence**.

# Phase 8 - Adopt in real consumers and run agent evaluations

## Summary

Prove usefulness and usability before hard-gating architecture policy.

## Detailed implementation steps

1. Create disposable sandbox repositories for destructive overlay, stale-base,
   rollback, parallel-worktree, and adversarial agent flows.
2. Establish a documentation-only baseline using paired tasks and fixed
   repository snapshots.
3. Run at least twelve adversarial task families plus clean controls across
   multiple seeds and agent configurations.
4. Adopt the capability advisory-first in Orchestrator using its real
   architecture facts and a separate PR.
5. Adopt advisory-first in Platform after updating Foundation and resolving its
   consumer-owned integration gaps.
6. Prepare Agent Runtime and frontend profiles only when their architecture is
   sufficiently concrete; do not force the Orchestrator profile onto them.
7. Compare planned findings, integrated findings, human review, rework,
   violations, false blocks, runtime, and token overhead.
8. Extract a shared architecture profile only if two consumers demonstrate the
   same semantics, parity fixtures exist, and duplicate consumer code is removed.
9. Publish limitations and unsupported areas alongside positive evidence.
10. Maintain a `ConsumerAdoptionRecord@1` for Foundation, Orchestrator, Platform,
    Agent Runtime, and frontend. It records exact repository SHA, owner,
    profile/policy identities, applicable and unsupported surfaces, mode, CI
    wiring, evidence, blockers, rollback, and next review trigger. Runtime and
    frontend may record `not-ready`, but only with objective admission criteria
    and named blockers before v1.

## Safety rule

Never test agent launch, provisioning, terminal runtime, task assignment, or
smoke flows on real user projects. Agent-behavior evaluations use only new
sandbox/test projects or explicitly designated existing test projects. Real
consumers receive static/advisory capability checks through ordinary reviewed
PRs.

## Evaluation protocol

- preregister primary outcomes, task families, held-out split, exclusion rules,
  and stopping rule;
- pin repository snapshots, agent/model/tool versions, budgets, and randomized
  paired order;
- treat seeds as repeated measures and task/repository as the primary sampling
  unit;
- justify sample size by power or precision and report paired hierarchical or
  cluster-bootstrap 95% confidence intervals;
- use blinded dual human adjudication, a written rubric, disagreement resolution,
  and inter-rater agreement;
- define timeouts, refusals, tool failures, partial work, and missing runs before
  observing results;
- bind immutable run manifests and replay artifacts to every observation;
- count attempted, completed, unavailable, and silently skipped workflow steps;
- include isolated materializations of representative public or consented
  snapshots and held-out historical task shapes, never live mutation flows.

## Metrics

- complex architecture task success improves by at least 10 percentage points;
- architecture violations per completed task decline by at least 50%;
- repeated invalid attempts decline by at least 30%;
- clarification and architecture-rework turns decline by at least 25%;
- clean simple-task success regresses by no more than two points;
- known incomplete observation produces zero exact passes;
- stale base, overlay, and policy receipts are rejected in every accepted case;
- clean-change false blocking remains below 2% before hard-gate promotion;
- median protocol token overhead remains at or below 8%;
- complex-task wall-clock overhead remains at or below 10%.

Promotion uses confidence bounds rather than point estimates. For each rule,
`RulePromotionRecord@1` contains rule, consumer, profile, policy, analyzer,
suite, exact-SHA identities, exposure interval, denominators, escapes, false
blocks, confidence intervals, incidents, owner/approver, rollout cohort, prior
mode, rollback operation, trigger thresholds, and response SLA. D8 separately
accepts the rule-specific escape ceiling and requires the upper confidence bound
to remain below the false-block ceiling. Promotion follows
`shadow -> advisory -> limited-required -> required`, with post-promotion
monitoring and deterministic per-rule fallback.

## Rollback

Consumer activation starts advisory and has one configuration-level kill switch.
False-positive or availability incidents may remove the declaration or return a
rule pack to advisory without deleting evidence. Containment, integrity,
false-pass, or evidence-trust incidents instead mark the implementation
`security-disabled` or `unsupported`; required consumers restore a known-good
verifier or block integration until coverage returns. They never convert the
incident into `pass`.

## Acceptance criteria

- two real consumers complete opt-in adoption with consumer-owned profiles;
- published evals show benefit without unacceptable clean-task regression;
- no hard gate is enabled solely from synthetic accuracy;
- unsupported frameworks and observation gaps remain explicit.
- every consumer, including a justified `not-ready` consumer, has an adoption
  record and reassessment trigger;
- every required rule has a complete promotion record and tested rollback.

Approximate change: **3,000-5,000 lines across Foundation, consumers, fixtures,
and eval harnesses**.

# Phase 9 - Harden release and graduate enforcement

## Summary

Publish a hardened successor to the qualified experimental cohort and prepare
the v1 evidence boundary.

## Detailed implementation steps

1. Freeze exact schema, vector, package, and conformance-suite versions.
2. Run package, tarball, registry-install, upgrade, downgrade, and public API
   qualification against exact commits.
3. Produce SBOM, provenance, reproducible build evidence, and dependency review.
4. Complete independent security and architecture reviews.
5. Enforce advisory performance budgets and retain history by exact SHA;
   promote only deterministic resource ceilings to hard gates.
6. Rebalance CI using measured critical-path data. Keep coverage parallel to
   primary tests, shard independent suites, and isolate Windows filesystem tests.
7. Before the first public package, accept D9's release ADR, update the current
   Changesets RC-wave procedure, and prove that candidate tarballs can remain
   private while stable `0.x.0` packages alone are public. Never unpublish,
   overwrite, or repair an immutable version through an ad hoc dist-tag change.
8. Promote individual consumer rules only through a valid
   `RulePromotionRecord@1` that passes D8.
9. Document migrations, known limitations, deprecation windows, and rollback.

## Release stop conditions

Stop the affected dogfood, promotion, adoption, and publication phases if:

- canonicalizers disagree;
- identical inputs and profiles produce nondeterministic identities or results;
- incomplete coverage can yield an unqualified pass;
- evidence resolves to bytes outside the bound snapshot;
- overlay validation accepts a stale base, applies partially, or writes to the
  repository;
- a secure snapshot escapes root, follows a forbidden symlink, executes target
  content, or uses the network;
- resource limits can be bypassed;
- provider self-assertion is presented as authenticated trust;
- two consumers require undocumented Node behavior;
- critical security issues or public API qualification failures remain open.
- trusted evidence issuer or merge-authority requirements cannot be verified.

## Rollback

- do not publish from a failed candidate;
- consumers pin exact last-known-good stable versions;
- false-positive/availability incidents use the tested per-rule advisory
  fallback; containment, integrity, false-pass, and evidence-trust incidents
  disable the affected implementation and restore a known-good verifier or block
  integration;
- a security release may disable an unsafe capability but may not reinterpret
  existing snapshot identities.
- preserve prior evidence, publish affected-version guidance, assign an incident
  owner, and drill both rollback classes before promotion.

## Acceptance criteria

- exact stable artifacts pass all release-owned gates;
- consumer upgrade and downgrade paths are proven;
- every required rule has measured promotion evidence and a rollback path;
- release checks reuse exact-SHA evidence rather than rerunning unchanged heavy
  suites without new risk.

Approximate change: **1,500-3,000 lines of release, CI, documentation, and tests**.

# Phase 10 - Define v1.0 readiness

## Summary

Do not declare v1 merely because the reference implementation works.

## v1 entry criteria

- several diverse public repositories use the 0.x standard;
- at least two real consumers implement from public documents and fixtures;
- at least one identity-critical implementation or oracle is independent of the
  production TypeScript code;
- complete language-neutral conformance vectors exist for every normative
  `MUST`;
- the secure profile and hostile corpus pass on supported platforms;
- no unresolved normative ambiguity or critical security defect remains;
- compatibility and deprecation policy has survived at least one real 0.x
  migration;
- governance, namespace ownership, release authority, and trademark position
  are documented honestly;
- performance, false-block, escape, and agent-effectiveness evidence is public;
- future transports, plugins, registries, sessions, caches, DSLs, and framework
  inference remain outside v1 unless separately admitted by evidence.

## v1 rejection criteria

Return to the relevant earlier phase if a second implementation cannot conform
without copying Node behavior, if identity semantics change, or if real consumer
profiles require a universal ontology hidden inside extensions.

Approximate change: **800-1,500 lines of specification, migration, governance,
and release evidence**, excluding any separately admitted feature.

## 8. Pull request sequence

Each PR owns one coherent evidence boundary. Independent oracle/security work
has different ownership from production code. Target approximately 1,500-3,500
handwritten lines per review PR; generated output and large fixture corpora are
reported separately.

```text
PR0 decisions, naming, governance, threat model
  -> PR1 normative schemas, registries, manifests, and vectors
     |-> PR2A production identity/result kernel
     `-> PR2B independent oracle and runner skeleton
  -> PR3A secure snapshot adapter
     `-> PR3B independently owned hostile filesystem/path corpus
  -> PR4A classify/evaluate profiles and effective-policy compiler
     `-> PR4B atomic overlay profile
  -> PR5 machine-first CLI, workflow, freshness, and explain UX
  -> PR6 black-box conformance integration and seeded bad providers
  -> PR7 Foundation adapter, clean bootstrap, dogfood, and dual-run parity
  -> PR8 publisher migration and qualified experimental cohort
     |-> PR-C1 Orchestrator advisory adoption
     `-> PR-C2 Platform advisory adoption
  -> evaluation report and ConsumerAdoptionRecord updates
  -> PR9 hardened successor release
  -> PR-P* separate per-rule enforcement-promotion PRs
```

| PR | Blocking evidence | Approximate handwritten change |
| --- | --- | ---: |
| PR0 | D0-D11 decisions and accepted ADRs; no public identifiers assumed before merge | 1,200-2,000 lines of prose |
| PR1 | PR0; normative authority and reproducible generation | 1,500-2,500 lines |
| PR2A / PR2B | PR1; separate ownership and no shared production canonicalizer | 2,000-3,500 lines each |
| PR3A / PR3B | PR2A/PR2B; exact attacker model and hostile corpus ownership | 2,000-3,500 lines each |
| PR4A / PR4B | PR2A and PR3A; immutable profile manifests | 2,000-3,500 lines each |
| PR5 | PR4; stable JSON, workflow, freshness, pagination, decision traces | 2,000-3,500 lines |
| PR6 | PR2B, PR3B, PR5; black-box and cross-version evidence | 2,000-3,500 lines |
| PR7 | PR6, D6-D7/D10; bootstrap, dogfood, normalized dual-run parity | 2,500-4,000 lines |
| PR8 | PR7, D9-D11; generated release PR and Qualified Cohort | 1,500-2,500 lines |
| PR-C1 / PR-C2 | Exact published cohort; repository-local activation and rollback | 1,000-2,500 lines each |
| PR9 / PR-P* | Accepted eval and promotion records | Scope-specific; never combined across consumers/rules |

The Foundation release PR remains separate from consumer adoption, evaluation,
and enforcement promotion. This prevents an adoption or statistical problem
from mutating the published package candidate.

### LOC accounting baseline

Only handwritten production and test/harness code contributes to the delivery
total. Normative prose, generated bindings, vectors/fixtures, and consumer
configuration are tracked separately. PR changed-line estimates intentionally
include those artifacts and therefore must not be summed as implementation LOC.

| Non-overlapping delivery category | Handwritten implementation |
| --- | ---: |
| Complete 0.x standard/reference/conformance/CLI vertical slice | 22,000-33,000 lines |
| Additional hostile-input, provenance, and cross-platform hardening | 3,000-5,000 lines |
| Foundation adapter and dogfood | 2,000-4,000 lines |
| Consumer adoption and agent-eval harnesses | 5,000-8,000 lines |
| Release, migration, and promotion automation | 2,000-4,000 lines |
| **Hardened cumulative total across repositories** | **34,000-54,000 lines** |

Separately expected: 3,000-5,000 lines of normative prose/ADRs, 5,000-10,000
lines of checked-in vectors and hostile fixtures, and 2,000-6,000 generated lines.
Each completed PR updates this ledger using actual changed-line categories.

## 9. CI and feedback strategy

### Local development

- run focused package tests while editing;
- run `check:changed` while editing;
- run `check:fast` once before handoff, not after every file write;
- run `verify` once before opening a PR;
- use additional complete platform/release suites only at their owned boundaries;
- use native TypeScript 7 preflight where compatible, while retaining the pinned
  project compiler as the reproducible gate.

### Pull requests

Run independent lanes in parallel:

- draft PR: pinned Dependency Review/SBOM and `check:changed`, with no heavy
  CodeQL or test work;
- ready PR: Dependency Review is a prerequisite for every executable job;
- lint, typecheck, architecture, schema, generated-drift, package/API,
  conformance/security, and static lanes run in parallel checkouts;
- four isolated Linux test shards emit raw coverage evidence; one fail-closed
  aggregator merges it without rerunning tests;
- Windows runs the weighted manifest as two sequential-shard jobs plus its
  static/package/registry/published lanes;
- macOS owns its qualification lane;
- race-sensitive filesystem tests remain isolated inside their platform lane;
- stable `check`, `windows-check`, and `macos-qualification` contexts are
  fail-closed aggregators;
- CodeQL's `CodeQL` and `analyze` contexts remain independent;
- performance history remains advisory.

Each lane publishes exact-SHA evidence. Retry only the unproven phase after a
bounded infrastructure failure. Do not rerun an unchanged successful exact-head
lane merely as ceremony. Event-separated concurrency prevents release dispatch
from cancelling PR evidence.

### Release

```text
EvidenceReuseKey =
  repository + fullHeadSha + PR/base/head tuple +
  workflow path/event/run/attempt + job/shard +
  source/lock/config/manifest/toolchain digests +
  OS/architecture + artifact/result digests
```

Release qualification reuses PR evidence only after verifying an evidence
envelope bound to repository, source and merge SHA, base SHA, workflow path and
blob digest, event/job identity, runner/toolchain image, lockfile,
schema/profile/vector digests, artifact inventory, and result digests. Its issuer
must satisfy the accepted merge-authority profile; PR-controlled workflow output
is never trusted merely because it names an exact SHA. Unverifiable evidence is
rerun inside the release-owned protected boundary. Registry installation,
packed-artifact inspection, upgrade, downgrade, provenance, and consumer canary
remain release-owned evidence.

Evidence is never reused across SHAs. A generated release commit runs complete
exact-head required CI; publishing may consume that reviewed SHA's evidence.
Ordinary reruns may aid development, but release attestation follows the current
attempt-1 or fresh-explicit-dispatch rule and never combines evidence from
different attempts.

## 10. Compatibility and deprecation

- version the standard, schema bundle, reference packages, operation profiles,
  evaluator profiles, and conformance suite separately;
- v1.x readers understand every earlier v1.x core document;
- a minor release may add a new optional profile or immutable envelope version;
  senders emit only the mutually negotiated envelope version, so older closed
  readers never receive unknown core fields;
- required fields, changed defaults, canonicalization, identity inputs, or
  existing meaning require a major release;
- unknown core fields are rejected;
- profiles are immutable; behavior changes create a new profile ID and digest;
- snapshot identities retain their original meaning permanently;
- experimental extensions cannot satisfy core conformance;
- normal deprecations receive two minor releases and at least twelve months
  before removal in the next major;
- emergency security releases may disable an unsafe capability but cannot
  silently reinterpret existing evidence;
- a published semantic defect withdraws the affected conformance claim and
  introduces a replacement envelope/profile version; historical evidence remains
  decodable, and consumers can pin or disable without mutating old identities.

## 11. Observability and durable evidence

Every phase emits a compact, versioned report containing:

- exact repository and commit;
- standard, profile, provider, analyzer, and conformance versions;
- input, snapshot, policy, overlay, and result identities;
- coverage, omissions, and unsupported areas;
- checks executed with durations and result digests;
- replay seed for property or fuzz failures;
- evidence `integrityStatus`, `producerAssurance`, and `semanticStatus`;
- promotion status: experimental, shadow, advisory, or required.

Do not add central telemetry in v0.x. Reports stay local and portable by default.
Future telemetry is a separate opt-in adapter with published schema, endpoint,
retention, preview, and disable controls.

## 12. Deferred features and preserved seams

The following remain documented research items, not implementation tasks:

- Python, Rust, Go, and Dart adapters;
- MCP, HTTP, daemon, and streaming transports;
- community marketplace or hosted registry;
- executable plugin loading;
- UI setup wizard;
- persistent or distributed cache;
- stateful agent sessions;
- leases and cross-process locks;
- universal architecture Rule DSL;
- automatic DDD, Clean Architecture, or FSD inference;
- signed evidence, remote stores, and certification;
- broad framework adapter catalog.

The only v0.x commitments are the language-neutral data contracts, namespaced
extensions, independent versions, deterministic analysis keys, static provider
boundary, content descriptors, budgets, and black-box conformance manifest.
v0.x content descriptors never dereference URLs, redirects, registries, or
network locations; remote descriptors are `unsupported` and have negative
vectors. A future remote feature requires a separate authentication,
authorization, replay, SSRF/DNS-rebinding, tenancy, egress, encryption,
retention, revocation, redaction, backpressure, and privacy threat model.

## 13. Normative traceability and rollback matrix

Before any public conformance claim, maintain one executable matrix that maps
every normative `MUST` to its owner, positive and negative vectors, supported
version pairs, exact evidence artifact, promotion state, and rollback drill.

| Contract area | Minimum evidence | Required rollback drill |
| --- | --- | --- |
| Resolution taxonomy and mixed batches | Per-target reconciliation plus malformed, duplicate, cancelled, exhausted, and provider-fault vectors | Withdraw affected envelope/profile and preserve historical decoding |
| Version negotiation | Old/new reader-writer matrix, no-overlap, downgrade, and bootstrap-problem vectors | Pin prior envelope and reject unsafe negotiation |
| Extensions | Unknown optional/critical, location, disposition, identity, collision, and size vectors | Disable or replace extension without changing core identities |
| Canonicalization and identities | Independent exact-byte oracles and every identity-input mutation | Block release, restore prior implementation, retain old identity decoder |
| Profile substitution | Full profile corpus, seeded bad providers, cross-provider evidence | Withdraw conformance claim and select replacement digest |
| Policy composition and bindings | Effective-policy provenance, conflict, override, exception, upgrade, and downgrade fixtures | Remove binding or pin exact prior module/preset |
| Consumer adoption | Activation/non-activation, CI wiring, integration receipt, and `ConsumerAdoptionRecord@1` | Repository-local capability removal or approved mode transition |
| Rule promotion | `RulePromotionRecord@1`, confidence bounds, incidents, and post-promotion monitoring | Per-rule advisory fallback for availability or fail-closed security disablement |
| Historical receipts and publication | Old-receipt verification, packed upgrade/downgrade, profile withdrawal, and trusted issuer evidence | Pin known-good package, publish affected-version guidance, never rewrite artifacts |

## 14. Final definition of done

The complete initiative is done when:

1. The accepted standard can be implemented without importing Foundation or
   reading TypeScript internals.
2. The Node reference passes independent exact-byte, security, and operation
   conformance profiles.
3. Foundation dogfoods its opt-in adapter through the public boundary.
4. Orchestrator and Platform complete separate advisory-first adoption with
   consumer-owned policies; Agent Runtime and frontend have accepted adoption or
   explicit `not-ready` records with objective v1 reassessment triggers.
5. Agent evals on disposable repositories demonstrate the agreed improvement
   without unacceptable false blocking, time, or token regression.
6. Integrated-state validation catches parallel-worktree and stale-receipt
   conflicts before merge.
7. Stable packages pass exact tarball, registry, upgrade, downgrade, public API,
   provenance, and consumer-canary gates.
8. Every required rule has evidence, an owner, a stable code, and a rollback.
9. Deferred platform ideas remain deferred unless their admission evidence is
   accepted separately.
10. Documentation distinguishes implemented, released, dogfooded,
    consumer-enabled, and required states.

Until all applicable criteria hold, public documentation must describe the work
as an experimental 0.x standard and reference implementation rather than a
universal production guarantee.

## 15. Review record

Five independent hosted reviewers read immutable draft commit
`ef96df4346e69d2ae140150c62bbdde7a74075fd`. Their accepted corrections are
implemented by commit `8e77d4e6023bc9d5502efb70bb3ae33e507cd100`. Findings were applied by semantic
contract rather than copied mechanically.

| Reviewer lens | Status | Accepted findings | Rejected findings |
| --- | --- | --- | --- |
| Protocol and semantic consistency | Complete; draft rejected, corrected plan accepted for owner decisions | Requested-target reconciliation, budget/fault split, immutable envelope negotiation, normative identity table, extension disposition, profile manifests, independent conformance, traceability, and LOC accounting | A second implementation language remains preferred rather than mandatory for 0.x; dependency and lineage independence are mandatory |
| Security and hostile repository behavior | Complete; conditional approval after corrections | Honest portable-Node race boundary, strict secure links/paths, inert config authority, prompt/terminal-safe output, trusted CI issuer, aggregate budgets, orthogonal evidence assurance, fail-closed security rollback, and remote deny-by-default | Native `openat2`/sandbox adapters, PKI, remote transport controls, and universal confusable detection remain deferred until their features are admitted |
| SOLID, Clean Architecture, and DDD boundaries | Complete; revise-before-implementation findings resolved | Feature-owned reference slices, minimal shared kernel, no conformance-to-reference dependency, D10 bootstrap DAG, minimal core registries, normative substitutability, pre-publication D1 authority, and normalized accounting | The three operations are not forced into three separate packages; profile boundaries and import rules provide isolation without package-per-use-case overhead |
| Agent UX, eval design, and consumer adoption | Complete; draft promotion gate rejected, corrected gate accepted for owner thresholds | `RulePromotionRecord@1`, statistical eval protocol, canonical read-only workflow, mandatory header, stateless pagination, freshness matrix, decision traces, closed composable bindings, adoption records, and skip accounting | The workflow is not a write gateway and cannot replace integration verification; hidden sessions/caches and automatic architecture inference remain out of scope |
| Delivery sequencing, CI, release, and OSS evolution | Complete; draft release cycle rejected, corrected sequence accepted for owner decisions | Phase 7.5 public cohort, PR0 decisions, independent production/oracle branches, evidence custody key, dual-run authority migration, D11 governance, current hosted CI DAG, and reconciled LOC | Classify/evaluate share one coherent PR and overlay owns another instead of three operation PRs; this preserves reviewability with less process overhead |
