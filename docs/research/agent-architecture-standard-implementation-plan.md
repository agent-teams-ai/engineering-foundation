# Agent Architecture Standard implementation plan

Status: Proposed final plan; implementation has not started and the plan awaits
independent review plus acceptance of the decision checkpoints

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

The proposed naming system is:

- **Agent Architecture Standard (AAS)**: the semantic model, profiles,
  evidence rules, compatibility rules, and conformance requirements;
- **Agent Architecture Protocol (AAP)**: the request, response, negotiation,
  and future transport layer inside the broader standard;
- full `agent-architecture-*` identifiers in packages, repositories, schemas,
  commands, and search titles; never bare `aas` or `aap` identifiers.

The initial implementation is expected to add approximately **20,000-30,000
handwritten lines including tests**. Security hardening, adversarial fixtures,
and independent conformance work may bring the cumulative total to
**30,000-44,000 lines** before v1.0.

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
| D3 | Canonical JSON profile | I-JSON restrictions, RFC 8785-compatible canonicalization, SHA-256, domain-separated identities | Snapshot and evidence identities |
| D4 | Mandatory secure snapshot profile | Root-relative paths, no symlink following, bounded capture, no execution or network | Node discovery implementation |
| D5 | Initial operation profiles | `classify-subjects@1`, `evaluate-relations@1`, `validate-overlay@1` | Vertical slice |
| D6 | First consumer profiles | Consumer-owned Foundation, Orchestrator, and Platform profiles; no shared architecture preset until semantic parity exists | Adoption |
| D7 | Enforcement graduation | Shadow first; hard gate only after published safety and false-block evidence | Required consumer CI |
| D8 | Public stable-release policy | Stable 0.x releases only after exact tarball qualification; no public `-rc` suffix | Publication |

The plan assumes the recommended choices. A changed decision requires updating
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
    src/domain/           immutable identities, outcomes, coverage, evidence
    src/application/      operation use cases and small provider ports
    src/adapters/node/    secure filesystem and hashing adapters
    src/composition/      explicit Node composition root
    src/cli/              machine-first local commands
  agent-architecture-conformance/
    src/runner/           black-box provider runner
    src/oracles/          independently implemented identity checks
    security-corpus/      hostile repository and overlay fixtures
    reports/              schema for portable conformance evidence
  engineering-foundation/
    src/capabilities/<provisional-agent-contract-id>/
                          opt-in Foundation adapter and diagnostics
```

The exact Foundation capability ID is selected during D6. A provisional name
must not leak into published configuration before the activation and ownership
semantics are agreed.

### 5.1 Dependency direction

```text
agent-architecture-standard
  <- agent-architecture-reference
  <- agent-architecture-conformance through public provider contracts only
  <- engineering-foundation opt-in capability
  <- consumer configuration and merge policy
```

Forbidden dependencies:

- the standard package importing Node, Foundation, consumer code, or a parser;
- the reference package importing Foundation capabilities;
- the conformance runner importing reference implementation internals;
- product/runtime code importing Foundation solely to execute the standard;
- normative schemas being generated from handwritten TypeScript types;
- consumer domain names or bounded-context catalogs entering any core package.

### 5.2 SOLID and Clean Architecture mapping

| Principle | Concrete boundary |
| --- | --- |
| SRP | Specification, identity/canonicalization, snapshot capture, evaluation profiles, CLI, conformance, and Foundation adoption remain separate change actors |
| OCP | New operations and vocabularies use namespaced, independently versioned profiles rather than central enum edits |
| LSP | Providers are substitutable only when they advertise and satisfy the same operation, evaluator, vocabulary, limits, and conformance profile |
| ISP | Providers implement small capability profiles; no universal analyzer interface or empty methods |
| DIP | Operation use cases own ports; Node filesystem, hashing, clock, and parser details are outbound adapters |
| Clean Architecture | Normative model and pure policies point inward; CLI, filesystem, Git, Foundation, and future transports point inward through public boundaries |
| DDD | Protocol negotiation, snapshot identity, evidence/coverage, architecture vocabulary, and overlay validation remain explicit bounded contexts |

## 6. Normative v0.x contract

### 6.1 Version axes

Keep these versions independent:

- standard version;
- encoding and canonicalization version;
- protocol envelope version;
- operation profile version;
- vocabulary and evaluator profile version;
- provider and analyzer version;
- conformance suite version;
- optional extension version.

A new operation or vocabulary must not require a standard major release. A
change to identity-bearing canonicalization, required fields, defaults, or
existing semantic meaning requires a major version.

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
namespaced `extensions` and `criticalExtensions` containers. Unknown critical
extensions produce `unsupported`; noncritical extensions may be preserved or
ignored according to the profile.

### 6.3 Resolution model

Every accepted target receives exactly one resolution:

- `decided`;
- `needs-input`;
- `indeterminate`;
- `unsupported`;
- `stale`.

Evaluation profiles place `pass`, `fail`, or `not-applicable` inside a `decided`
resolution. Parse failures, provider crashes, and resource-limit faults use the
problem model rather than architecture verdicts.

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

Identity-bearing JSON uses deterministic ordering, integers, explicit algorithm
identifiers, duplicate-key rejection, normalized path rules, and stable domain
separators. Absolute paths, timestamps, inode numbers, user IDs, environment
values, and machine-local roots never affect portable identities.

### 6.5 Coverage and evidence

Coverage reports the declared denominator and terminal state for discovery,
capture, classification, evaluation, and overlay reevaluation. Included,
policy-excluded, unreadable, unsupported, unstable, unknown, and
budget-exhausted units remain distinguishable.

Evidence identifies immutable content, byte range or structured pointer,
producer, derivation, sensitivity, input digest, and applicable rule/profile.
The implementation verifies referential consistency where possible but never
claims that a self-asserted provider identity proves trust or truth.

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

1. Accept or amend D0-D8.
2. Add an ADR for the standard/reference/Foundation authority split.
3. Add an ADR for identity and canonicalization authority.
4. Publish a glossary for snapshot, artifact, subject, relation, profile,
   analyzer, evidence, coverage, overlay, resolution, problem, and receipt.
5. Publish the v0.x compatibility policy and experimental-extension rules.
6. Publish the malicious repository/config/analyzer threat model.
7. Record the deferred-feature register and explicit admission triggers.
8. Define the first two consumer scenarios and the disposable eval repositories.
9. Define license, contribution, namespace, and governance assumptions without
   claiming an independent foundation or certification program.

## Risks and edge cases

- AAS acronym collision and package/domain availability.
- Normative prose contradicting schemas or vectors.
- Foundation internals becoming de facto standard behavior.
- Consumer examples accidentally becoming universal domain semantics.
- Scope expanding to plugin loading, transports, sessions, or a Rule DSL.

## Tests and verification

- documentation reference and ADR checks;
- glossary term consistency scan;
- schema/spec/vector authority table reviewed by two people;
- package, domain, repository, and trademark collision evidence recorded before
  public branding.

## Rollback

No runtime or consumer behavior changes. Revert the proposed ADRs before they
are accepted, or supersede accepted ADRs explicitly.

## Acceptance criteria

- D0-D8 have explicit outcomes;
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
3. Implement bounded traversal that rejects escape, devices, sockets, FIFOs,
   unsafe encodings, and forbidden symlink behavior.
4. Hash from stable handles where the platform permits and compare metadata
   before and after capture.
5. Represent unreadable, unstable, unsupported, excluded, and exhausted entries
   explicitly in coverage.
6. Build immutable manifest ordering and snapshot identity generation.
7. Add disclosure policy so file content and snippets remain absent by default.
8. Add cancellation and deterministic resource-limit outcomes.
9. Make platform limitations explicit: return `unsupported` or `indeterminate`
   rather than silently weakening the secure profile.

## Risks and edge cases

- symlink swaps and TOCTOU races;
- hard links, case-insensitive collisions, Unicode aliases, and changing files;
- nested repositories and submodules;
- ignored files versus policy-excluded files;
- huge trees, sparse files, and permission changes;
- Windows reserved names and separator behavior;
- cancellation after partial capture.

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

- no root escape or target mutation in the accepted adversarial corpus;
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

## Risks and edge cases

- paths treated as universal subject IDs;
- planned relations leaking into observed state;
- a global result hiding mixed per-target outcomes;
- overlay rename/case/line-ending ambiguity;
- stale base or precondition accepted partially;
- generic confidence values without defined scale;
- evaluators advertised as substitutable without shared fixtures.

## Tests and verification

- profile-level positive, negative, unknown, stale, and unsupported fixtures;
- one resolution per target property;
- planned versus observed isolation tests;
- overlay atomicity and stale-precondition tests;
- mutation and property testing for virtual overlay application;
- diagnostic stability and bounded-message tests;
- conformance fixtures authored separately from production code.

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

1. Add `describe`, `inspect`, `classify`, `evaluate`, `overlay validate`, and
   `explain` commands over the public provider boundary.
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

## Risks and edge cases

- agents skipping optional commands;
- JSON output polluted by progress logs;
- implicit current directory selecting the wrong repository;
- context windows truncating critical omissions;
- receipts reused after rebase or policy change;
- explanations showing untrusted source content as instructions;
- CLI conveniences becoming undocumented protocol semantics.

## Tests and verification

- command contract and exit-code fixtures;
- stdout/stderr separation tests;
- wrong-root, missing-input, stale-receipt, cancellation, and partial-output
  cases;
- large diagnostic-set truncation with explicit omission metadata;
- packed CLI install tests on supported platforms;
- agent-readable JSON snapshots and human-render parity tests.

## Rollback

CLI commands remain additive and experimental during 0.x. Hard policy does not
depend on agent invocation; the integration verifier remains authoritative.

## Acceptance criteria

- a fresh repository produces useful bounded output in one command;
- every hidden assumption is explicit in JSON identities or coverage;
- agents can determine whether a result is current without prose interpretation;
- no prompt, model, daemon, or network service is required.

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

## Risks and edge cases

- shared production/oracle code making false agreement;
- a validator that blocks everything appearing safe;
- nondeterministic fuzz failures without replay seeds;
- Windows filesystem behavior dominating feedback time;
- optional security tests being skipped as unsupported;
- conformance being mistaken for analyzer trustworthiness.

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

1. Select the capability ID and configuration schema through D6.
2. Add one feature-owned capability slice with its own contract, application,
   adapters, fixtures, schema, and diagnostics.
3. Accept consumer-owned local paths to architecture profile, policy, and
   optional baseline evidence.
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

## Risks and edge cases

- cyclic product dependency on Foundation;
- duplicated schema or diagnostic semantics;
- static `check` unexpectedly executing analysis scripts;
- capability activation after an ordinary package upgrade;
- Foundation profile being presented as universal;
- existing source-dependency capability and new relation evaluation disagreeing.

## Tests and verification

- activation and non-activation fixtures;
- schema/runtime/explain/rule registry parity;
- Foundation dogfood fixture and exact integrated-state receipt;
- package dependency direction and public API checks;
- upgrade/downgrade tests proving old consumers remain inactive;
- parity comparison with existing source-dependency findings where scopes
  overlap.

## Rollback

The capability is opt-in and removable from consumer configuration. Keep the
existing source-dependency capability authoritative until parity and migration
are explicitly accepted.

## Acceptance criteria

- Foundation uses the public standard boundary against itself;
- consumers remain owners of activation, vocabulary, policy, and exceptions;
- installation alone changes no check result;
- no standard package imports Foundation.

Approximate change: **2,000-3,500 lines including tests**.

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

## Safety rule

Never test agent launch, provisioning, terminal runtime, task assignment, or
smoke flows on real user projects. Agent-behavior evaluations use only new
sandbox/test projects or explicitly designated existing test projects. Real
consumers receive static/advisory capability checks through ordinary reviewed
PRs.

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

## Rollback

Consumer activation starts advisory and has one configuration-level kill switch.
Remove the capability declaration or return the rule pack to advisory without
changing the standard or deleting evidence.

## Acceptance criteria

- two real consumers complete opt-in adoption with consumer-owned profiles;
- published evals show benefit without unacceptable clean-task regression;
- no hard gate is enabled solely from synthetic accuracy;
- unsupported frameworks and observation gaps remain explicit.

Approximate change: **3,000-5,000 lines across Foundation, consumers, fixtures,
and eval harnesses**.

# Phase 9 - Harden release and graduate enforcement

## Summary

Convert the proven vertical slice into stable 0.x packages and prepare the v1
evidence boundary.

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
7. Publish stable `0.x.0` packages only after candidate tarballs pass; do not
   publish `-rc` versions.
8. Promote individual consumer rules from advisory to required only when their
   rule-specific escape and false-block evidence passes D7.
9. Document migrations, known limitations, deprecation windows, and rollback.

## Release stop conditions

Stop publication if:

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

## Rollback

- do not publish from a failed candidate;
- consumers pin exact last-known-good stable versions;
- hard-gate rules have per-rule advisory fallback and retain evidence;
- a security release may disable an unsafe capability but may not reinterpret
  existing snapshot identities.

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

Use a small number of reviewable, behaviour-complete PRs. Each PR owns one
coherent evidence boundary and may contain parallel worker commits with
non-overlapping ownership.

| PR | Scope | Depends on | Approximate change |
| --- | --- | --- | ---: |
| 1 | ADRs, glossary, threat model, package skeleton, normative authority | D0-D4 | 2,000-3,500 lines |
| 2 | Schemas, registries, generated bindings, artifact manifest, drift gates | PR 1 | 3,000-4,500 lines |
| 3 | Canonicalization, identities, outcomes, coverage, evidence kernel | PR 2 | 4,000-6,000 lines |
| 4 | Secure Node snapshot capture and hostile filesystem corpus | PR 3 | 4,000-6,000 lines |
| 5 | Three operation profiles and atomic virtual overlay | PRs 3-4 | 5,000-7,500 lines |
| 6 | CLI, agent UX, black-box conformance, independent oracles | PR 5 | 4,500-7,000 lines |
| 7 | Foundation opt-in capability and Foundation dogfood | PR 6, D6 | 2,500-4,000 lines |
| 8 | Sandbox evals, consumer advisory adoption, release hardening | PR 7, D7 | Split by repository; 5,000-8,000 lines total |

PR 8 becomes one PR per consumer because repository ownership and rollback are
independent. The Foundation release PR remains separate from consumer adoption
so an adoption problem cannot mutate the published package candidate.

## 9. CI and feedback strategy

### Local development

- run focused package tests while editing;
- run `check:changed` before handoff;
- run the fast gate after a coherent slice, not after every file write;
- use the complete suite only at integration and release boundaries;
- use native TypeScript 7 preflight where compatible, while retaining the pinned
  project compiler as the reproducible gate.

### Pull requests

Run independent lanes in parallel:

- lint, typecheck, architecture, schema, and generated-drift checks;
- core and operation test shards;
- secure filesystem matrix;
- black-box conformance and security corpus;
- coverage;
- package and public API qualification;
- performance history as advisory evidence.

Each lane publishes exact-SHA evidence. Retry only the unproven phase after a
bounded infrastructure failure. Do not rerun an unchanged successful exact-head
lane merely as ceremony.

### Release

Release qualification consumes exact-SHA PR evidence when the inputs and tool
versions match. Registry installation, packed-artifact inspection, upgrade,
downgrade, provenance, and consumer canary remain release-owned evidence.

## 10. Compatibility and deprecation

- version the standard, schema bundle, reference packages, operation profiles,
  evaluator profiles, and conformance suite separately;
- v1.x readers understand every earlier v1.x core document;
- optional fields and profiles may be added in minor releases;
- required fields, changed defaults, canonicalization, identity inputs, or
  existing meaning require a major release;
- unknown core fields are rejected;
- profiles are immutable; behavior changes create a new profile ID and digest;
- snapshot identities retain their original meaning permanently;
- experimental extensions cannot satisfy core conformance;
- normal deprecations receive two minor releases and at least twelve months
  before removal in the next major;
- emergency security releases may disable an unsafe capability but cannot
  silently reinterpret existing evidence.

## 11. Observability and durable evidence

Every phase emits a compact, versioned report containing:

- exact repository and commit;
- standard, profile, provider, analyzer, and conformance versions;
- input, snapshot, policy, overlay, and result identities;
- coverage, omissions, and unsupported areas;
- checks executed with durations and result digests;
- replay seed for property or fuzz failures;
- whether evidence is verified, locally trusted, or self-asserted;
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

## 13. Final definition of done

The complete initiative is done when:

1. The accepted standard can be implemented without importing Foundation or
   reading TypeScript internals.
2. The Node reference passes independent exact-byte, security, and operation
   conformance profiles.
3. Foundation dogfoods its opt-in adapter through the public boundary.
4. Orchestrator and Platform complete separate advisory-first adoption with
   consumer-owned policies.
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

## 14. Review record

This section will be completed after five independent reviews of this exact
plan. Each accepted finding must identify the changed section. Rejected findings
must include a brief rationale so that review is auditable rather than silently
ignored.

| Reviewer lens | Status | Accepted findings | Rejected findings |
| --- | --- | --- | --- |
| Protocol and semantic consistency | Pending | Pending | Pending |
| Security and hostile repository behavior | Pending | Pending | Pending |
| SOLID, Clean Architecture, and DDD boundaries | Pending | Pending | Pending |
| Agent UX, eval design, and consumer adoption | Pending | Pending | Pending |
| Delivery sequencing, CI, release, and OSS evolution | Pending | Pending | Pending |
