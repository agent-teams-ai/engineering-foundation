# Agent architecture standard design study

Status: Research record; direction accepted by ADR-0036, implementation remains
in progress

Date: 2026-08-26

## Purpose

This study records the candidate design for a machine-first open standard that
helps coding agents understand and preserve repository architecture. It is not a
claim that Foundation already provides the described protocol, and it does not
activate policy in any consumer.

The intended outcome is narrower than automatic architecture design. An agent
should be able to discover the applicable architecture contract, evaluate a
planned change against an exact repository state, understand incomplete
evidence, and prove that the integrated result still satisfies the contract.

## Accepted naming direction

The recommended naming system is:

- **Agent Architecture Standard (AAS)** for the language-neutral semantic model,
  conformance requirements, profiles, and evidence rules;
- **Agent Architecture Protocol (AAP)** only for request, response,
  negotiation, and future transport bindings;
- the dedicated Agent Architecture Standard repository as the authority home,
  without claiming an independent foundation or standards body.

The distinction is intentional: the standard defines what results mean, while
the protocol defines how implementations exchange them. Public identifiers must
use the full `agent-architecture-*` form rather than bare `aas` or `aap` names.
The AAS acronym has a serious standards-sector collision with Asset
Administration Shell, while AAP has broad non-software collisions and can be
confused with A2A, ACP, or MCP. Live package, domain, trademark, and standards
catalog checks remain mandatory before public branding. The GitHub repository
and scoped/unscoped npm package names were available when D0 was accepted; this
is namespace evidence, not legal trademark clearance.

The rejected alternative was to use Agent Architecture Protocol as the single public name
and describe it as an open standard. That is simpler, but it inaccurately makes
the static model and conformance semantics sound like a wire protocol.

## Recommended boundary

The target is a small document kernel with independently versioned operation and
vocabulary profiles. Foundation should be one replaceable Node and TypeScript
reference implementation, not the source of normative meaning.

```text
language-neutral specification and schemas
  <- pure codecs, canonicalization, identities, and result invariants
  <- independently versioned operation and evaluator profiles
  <- Node/filesystem/CLI adapters and Foundation capabilities
  <- agent integrations and consumer-owned architecture policy
```

The specification must remain understandable and implementable without Node,
Foundation, a daemon, an MCP server, or access to a hosted service. The
conformance runner must exercise the public provider boundary and must not reuse
the reference implementation as its only identity-critical oracle.

## Core documents

The stable kernel should define:

- capability and profile discovery;
- transport-neutral request, result, and problem envelopes;
- portable artifact and immutable snapshot identities;
- opaque subject references and role-named relation candidates;
- evidence, provenance, observation coverage, and diagnostics;
- explicit uncertainty and partial-result semantics;
- canonical encoding, digest domain separation, and deterministic ordering;
- namespaced optional and required extensions;
- declared budgets, cancellation, deadlines, and resource-limit outcomes;
- black-box conformance manifests and language-neutral fixtures.

Protocol state, analysis conclusions, and faults are separate concepts. A
malformed request or provider failure is a problem; it is not an architecture
decision. A plural operation returns one resolution for every requested target
rather than hiding mixed results behind one global outcome.

## Required result semantics

Every substantive result is bound to evidence equivalent to:

```text
standardVersion
operationVersion
profileId and profileDigest
repositoryId
baseRevision
worktreeId
snapshotId
overlayDigest
policyDigest
analyzerDigest
queryScope
coverageByStage
omissions
evidenceReferences
resultDigest
```

At minimum, operation resolutions distinguish:

- `decided` with the named profile that gives the verdict meaning;
- `needs-input` with machine-readable missing inputs;
- `indeterminate` with attempted coverage and applicable limits;
- `unsupported` with the unsupported version, feature, or profile;
- `stale` with the expected and observed identities.

Evaluation profiles may additionally define `pass`, `fail`, and
`not-applicable` verdicts inside a `decided` resolution. A provider or protocol
fault never masquerades as one of those verdicts.

## Initial operation profiles

### Subject classification

`classify-subjects@1` accepts explicit subject references and a named vocabulary
profile. It returns classification assertions under that profile. Subjects are
opaque, snapshot-scoped references rather than filesystem paths pretending to
be universal domain identities.

The core does not infer DDD, Clean Architecture, or Feature-Sliced Design. Those
semantics belong to explicit, versioned profiles owned by the parties that can
define and test them.

### Planned relation evaluation

`evaluate-relations@1` accepts relation candidates and a named evaluator
profile. Existing, declared, inferred, and planned relations are different
states. Planned relations carry a plan and overlay identity and never appear as
observed repository facts.

Adding a relation vocabulary or evaluator profile must not require a protocol
major release.

### Exact overlay validation

`validate-overlay@1` evaluates a declarative overlay against a required base
snapshot. It is atomic, bounded, side-effect-free, and stale-base-safe. It must
not write to the repository.

The profile defines portable path rules, add/replace/delete operations, path
preconditions, content limits, the prospective snapshot identity, and the scope
that was reevaluated. A pass means only that the named rules were evaluated over
the identified inputs; it does not imply runtime, security, or domain
correctness.

## Agent workflow

The standard is useful only when agents cannot silently skip it. The intended
repository-native flow is:

```text
open worktree
  -> discover applicable capabilities and profiles
  -> inspect snapshot, scope, freshness, and coverage
  -> propose subjects, relations, and an exact overlay
  -> evaluate the planned relations
  -> validate the overlay
  -> write the change
  -> run affected checks
  -> rebase or integrate
  -> validate the integrated result again
  -> record outcome evidence
```

Agent instructions should make the flow automatic at repository and worktree
boundaries. Prompts remain guidance, not enforcement. Hard architecture policy
is enforced by a deterministic merge-time verifier. The agent receives compact,
machine-first diagnostics with stable IDs, evidence, omissions, and applicable
repair choices.

The protocol can reduce structural violations, stale assumptions, and repeated
rework. It cannot invent correct bounded contexts, prove SOLID, or guarantee a
good domain model. Those claims require end-to-end agent evaluations rather than
schema or graph-query accuracy.

## Non-negotiable invariants

1. The standalone specification is authoritative; TypeScript behavior is not.
2. Every requested target receives exactly one resolution.
3. Faults and epistemic outcomes are never encoded as the same state.
4. Negative relationship answers require complete observation proof for the
   declared scope; otherwise the result is not-observed or indeterminate.
5. Snapshot, overlay, policy, analyzer, and result identities are distinct.
6. Changed content, base revision, policy, relevant index data, or integration
   state invalidates the earlier receipt.
7. Coverage names its denominator and stage; a percentage alone is not proof.
8. Incomplete, unreadable, unstable, unsupported, or budget-exhausted relevant
   inputs cannot yield an unqualified pass.
9. Every evidence reference resolves to immutable content in the same snapshot.
10. Digests prove integrity, not producer authenticity or semantic truth.
11. Unknown required extensions fail safely; optional extensions cannot change
    core semantics silently.
12. Core operations are stateless and side-effect-free.
13. Repository bytes and configuration are inert data, never instructions or
    executable plugins.
14. Rebase and integration require a new validation receipt.

## Security and privacy baseline

The mandatory secure profile must:

- use root-relative portable paths and reject traversal, absolute paths, NULs,
  normalization collisions, devices, sockets, and other unsafe entry types;
- never follow target-repository symlinks or execute repository scripts, hooks,
  imports, package installers, model calls, or network requests;
- bound traversal, entry size, total bytes, overlay operations, extension data,
  time, memory, and concurrency;
- hash from stable handles where supported and report unstable or unsupported
  capture rather than weakening the guarantee;
- validate analyzer output and recompute evidence references where possible;
- keep absolute paths, environment data, secrets, and source snippets out of
  portable reports by default;
- treat repository text as untrusted evidence in every future LLM adapter;
- reject a stale overlay atomically and never partially apply it.

Provider names and versions are self-asserted until independently verified.
Signatures, remote trust, plugin sandboxing, and hosted evidence stores require
separate threat models.

## Extension seams reserved in the kernel

The following seams belong in the data model now without implementing their
future ecosystems:

- independent standard, protocol, operation, vocabulary, evaluator,
  canonicalization, and extension version axes;
- URI- or reverse-DNS-namespaced operation, label, reason, evidence, and finding
  identifiers;
- `extensions` and `criticalExtensions` with size limits and `mustUnderstand`
  behavior;
- transport-neutral serializable envelopes;
- immutable profile, policy, analyzer, and provider descriptors with digests;
- content descriptors with media type, digest, byte length, and optional bounded
  inline bytes;
- cancellation, deadlines, and explicit resource budgets;
- deterministic analysis keys without a persistent cache implementation;
- statically wired provider interfaces without runtime discovery;
- a conformance manifest consumable by any implementation language;
- structured observability hooks that do nothing by default.

These are compatibility seams, not public plugin frameworks. They must remain
small and have conformance fixtures.

## Deferred research register

| Idea | Preserve now | Admission evidence before implementation |
| --- | --- | --- |
| Python, Rust, Go, and Dart adapters | Language-neutral schemas and vectors | A real consumer and independent implementer for each language |
| MCP, HTTP, and daemon transports | Serializable envelopes and content descriptors | Two consumers prove process invocation is inadequate; separate auth and replay threat model |
| Community marketplace | Namespaced provider metadata | Namespace, provenance, moderation, removal, and governance policy |
| Executable plugins | Static provider boundary | Repeated extensions cannot remain statically wired; isolation, signing, dependencies, and supply-chain model approved |
| UI configuration wizard | Stable operations and diagnostics | Demonstrated human setup friction not solved by agent-assisted configuration |
| Persistent or distributed cache | Deterministic analysis keys | Measured latency bottleneck; coherence, invalidation, privacy, and tenancy design |
| Stateful agent sessions | Stateless correlation and cancellation | Real workflow requires server-held state and defines recovery ownership |
| Leases and locks | Immutable worktree and overlay identities | Concurrent writer problem cannot be solved at repository integration boundary |
| Universal architecture rule DSL | Versioned evaluator profiles and findings | Several independent rule families share proven semantics and cannot use code-owned profiles |
| Automatic DDD, Clean, or FSD inference | Namespaced classification assertions | Independently evaluated precision, recall, uncertainty, and correction UX on diverse repositories |
| Signed evidence and remote stores | Digest-bound evidence and trust status | Concrete trust actors, key lifecycle, retention, privacy, and revocation requirements |
| Framework adapters | Import/export adapter boundary | Two consumers per adapter with shared semantics and parity fixtures |

No roadmap item is a compatibility promise, release commitment, or reason to
publish an empty extension point.

## Delivery options

The estimates include handwritten implementation and tests, but exclude
generated types, fixtures, and prose.

| Option | Scope | Confidence | Reliability | Complexity | Estimated change |
| --- | --- | ---: | ---: | ---: | ---: |
| Contract kernel | Schemas, canonicalization, identities, result semantics, vectors, minimal CLI | 6/10 | 8/10 | 3/10 | 10,000-16,000 lines including tests |
| Thin standard with complete vertical slice | Kernel, three profiles, useful local workflow, Node reference, diagnostics, conformance | 9/10 | 8/10 | 6/10 | 20,000-30,000 lines including tests |
| Hardened core | Vertical slice plus hostile-input corpus, fuzzing, independent oracles, provenance, cross-platform hardening | 9/10 | 9/10 | 7/10 | 30,000-44,000 lines including tests |

The recommended delivery path is not one giant release. Build the complete
vertical slice as a 0.x reference, run it in shadow mode, and promote only the
proven security and conformance surface into v1. The target is the hardened core;
the implementation sequence remains incremental.

## Staged evidence gates

### Scope and identity

Approve the vocabulary, trust boundaries, identity model, coverage invariant,
privacy defaults, naming, and deferred-feature register. Two independently
written canonicalizers must produce identical bytes and identities.

### Secure snapshot

Implement bounded Node discovery and immutable snapshot capture. Prove no root
escape, repository mutation, subprocess, network access, symlink weakening, or
silent incomplete coverage across supported platforms.

### Analysis and overlay

Implement the initial profiles, evidence validation, atomic virtual overlay,
prospective snapshot, property tests, and an adversarial corpus. Keep every hard
gate in shadow mode until false-block and escape rates are measured.

### Release candidate

Require black-box conformance, cross-platform runs, reproducible artifacts,
SBOM and provenance, security review, bounded performance, and two real consumers
implementing from the public specification rather than Foundation internals.

### Stable release

Freeze v1 only when there is no unresolved normative ambiguity, identity
disagreement, critical security defect, or undocumented reference-implementation
behavior required by consumers.

## Evaluation targets

Compare the integrated system with a documentation-only baseline using
adversarial and clean-control tasks. Initial acceptance targets are:

- at least a 10 percentage-point improvement in complex architecture task
  success;
- at least 50% fewer architecture violations per completed task;
- at least 30% fewer repeated invalid attempts;
- at least 25% fewer clarification and architecture-rework turns;
- no more than a two-point success regression on clean simple tasks;
- zero false exact passes in the accepted overlay mutation corpus;
- every stale base, overlay, and policy mismatch rejected;
- no exact pass when relevant observation coverage is incomplete;
- clean-change false blocking below 2% before a hard gate is enabled;
- median protocol token overhead no greater than 8% and end-to-end wall-clock
  overhead no greater than 10% on complex tasks.

These are release hypotheses, not current product claims. Thresholds must be
measured with published fixtures and confidence bounds.

## Foundation and consumer ownership

Foundation may dogfood the reference capability against its own source, but the
normative contracts remain in a standalone package and specification boundary.
Foundation capabilities translate consumer-owned facts and policy into protocol
documents, call the reference provider through public boundaries, and render
deterministic diagnostics.

Consumers continue to own their architecture vocabulary, paths, bounded
contexts, allowed relations, exceptions, applicability, and merge policy.
Installing or upgrading Foundation never activates a new hard rule. A reusable
profile or adapter is extracted only after two real consumers demonstrate the
same semantics, parity fixtures exist, and the duplicate consumer code is
removed.

## Accepted decisions and remaining evidence gates

ADR-0036 and the product decision record resolve the original architecture
choices:

1. Agent Architecture Standard is the public umbrella; AAP is a technical
   component.
2. Foundation may incubate privately, while the dedicated standard repository
   owns normative artifacts and conformance authority before public 0.x claims.
3. v0.x standardizes closed effective policy, not a module/preset compiler.
4. Public candidates use a non-`latest` RC channel before separately qualified
   numeric 0.x artifacts.

The preregistered D5 spike and independent adversarial review select an overlay-
first public surface. Evidence still decides the first real consumer-backed
vocabulary profile, rule-specific promotion thresholds, and the people assigned
to independent conformance and release roles. This study reserves safe seams but
does not authorize speculative platform work.
