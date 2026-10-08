# Engineering Quality Standard

This is the shared engineering baseline for repositories owned by
`agent-teams-ai`. Read it before planning, implementing, or reviewing changes,
then follow the target repository's instructions and applicable owner contracts.
Keep repository `AGENTS.md` and `CLAUDE.md` files as routes to this document;
do not copy these rules into each repository.

## Scope and authority

New and changed behavior must follow Clean Architecture, SOLID, DDD and DRY
through the concrete practices below. Apply them to the responsibility being
changed: a business context, library, host, integration, tooling package and
test fixture have different jobs. Do not create a domain model for a script or
retrofit an upstream fork merely to make its directories resemble a template.
Organization-owned changes in forks and fixtures still need explicit ownership,
appropriate tests and honest claims about their scope.

This maintained baseline owns common engineering practices and navigation. It
does not replace the immutable [Feature Module Standard v1](architecture/feature-module-standard/v1.md),
its [version registry and adoption rules](architecture/feature-module-standard/README.md),
or a repository's accepted ADRs, published contracts, security policy and scoped
adoption profiles. It neither selects technologies nor adopts Get Modular for
every repository. [Governance](../GOVERNANCE.md) owns authority boundaries.

Read the central version selected by the repository's accepted adoption profile
when applying a pinned architecture standard. A link to `main` is navigation to
current guidance, not permission to change a content pin, frozen contract or
accepted decision. Review upstream changes and use the owning adoption procedure.
Keep stricter local requirements. If rules conflict, identify the specific
conflicting requirements and follow the owning decision process before changing
that boundary; continue independent work. Never silently choose a weaker rule.

Required practices and demonstrated conformance are different claims. A new
link, installed library, approved plan or passing partial checker does not prove
that existing code conforms. Keep legacy gaps, exclusions, accepted deviations
and unqualified behavior explicit in their existing owner records. This document
does not require unrelated legacy migrations or create an exemption for new code.

## Early product advantage

Owner direction recorded on 2026-09-21: Agent Teams products should earn an
early advantage through demonstrated reliability, clear architectural
boundaries and predictable user outcomes, even when reference products such as
OpenClaw offer more features. Feature-count parity is not the primary objective.

For each selected product slice, state the concrete guarantee and demonstrate
it at the boundary where it matters: safe recovery without duplicate effects,
bounded overload with working cancellation, tenant isolation, or honest progress
and failure reporting. Choose the guarantees relevant to that slice; this is
not a mandatory list of new subsystems for every task.

Use source-backed competitor evidence to refine existing owners and acceptance
tests. Preserve successful protections as counterevidence and distinguish a
defect from a deliberate product tradeoff. Do not invent weaknesses or claim
superiority from documentation, technology names or unqualified prototypes.

Reduce feature scope before weakening an accepted correctness or safety
invariant. Keep delivery practical: reuse existing contracts and plans, finish
bounded vertical slices, and add abstractions or gates only for a demonstrated
risk. This priority introduces no automatic ADR migration, extra approval ritual
or requirement to build a universal platform before a useful feature.

Repository agent instructions link here; they do not duplicate this priority.

## Library-first design and deliberate evolution

Owner direction recorded on 2026-10-01: Agent Teams projects are at an early
stage. Treat this as a serious engineering rule, not a style preference.

Design a concern that is expected to serve several projects as a universal,
well-structured library from the start, with one owner and one contract.
Extracting consumer-local code into a library later and migrating every copy
costs more than adapting consumers to a deliberate change. Unify one concern
behind one implementation instead of letting each project keep its own variant.
Before choosing a shape, reason explicitly about how the contract will evolve
and scale. Validate it with disposable test projects and at least one real
consumer in the same delivery; that consumer proves the contract and is not an
incubator for it.

Breaking changes are allowed in every organization repository when they
deliberately improve the system. The MVP stage lasts until the owner records
its end in this standard or, for one repository, in that repository's
`AGENTS.md`, README or accepted decisions. A compatibility commitment exists
only where those repository documents explicitly declare one; commitments
already declared there stay in force, and the MVP stage implies none. Prefer
one clean contract over parallel variants, compatibility shims and deprecated
paths that accumulate legacy and become harder to migrate.

Packages still on 0.x stay on 0.x during the MVP stage and ship a breaking
change as a minor release; do not bump the major version for each break. A
package already at 1.0 or later marks a break with a major release, because a
caret range would otherwise install it silently. Every breaking release has a
changelog entry and a migration guide that states why the new shape is better
and how to move to it. Consumers adapt when they upgrade. Do not leave an old
and a new variant side by side without an owner and a removal step.

This direction does not relax minimalism, security or data safety. A library
carries only mechanism with a concrete need, product policy stays with its
owner, and speculative features, universal managers and service bags remain
out. Persisted user data, durable recovery state and in-flight work still need
a safe migration. Accepted decisions and pinned standards still change through
their successor process.

Repository agent instructions link here; they do not duplicate this direction.

## Clean Architecture and ownership

- Put invariants and policy with their semantic owner. Application use cases
  coordinate through narrow contracts; adapters implement external IO; outer
  composition selects concrete implementations. Dependencies point inward.
- Keep filesystem, network, database, provider SDK, transport and DI/framework
  details out of domain and application code where those layers apply. Follow
  the repository's exact dependency profile; public adapters may expose their
  own technical API without turning that API into the domain language.
- Declare outbound ports at their consuming boundary. Cross ownership through
  explicit public contracts and anti-corruption mappings; do not deep-import
  another context, access its repositories or mutate its private state.
- Keep transport DTOs, provider DTOs, application models, domain objects and
  persistence records separate where their contracts differ. Avoid mechanical
  layers of identical mappers that provide no boundary or validation.
- Keep composition roots thin. They assemble capabilities and establish explicit
  lifecycle ownership according to the repository contracts. Where an adopted
  profile assigns ownership to a Host, follow that profile. Roots do not absorb
  domain workflows, protocol interpreters or authorization decisions. No hidden
  service locator or global mutable registry.

## SOLID in practical terms

| Principle | Required practice | Common failure |
| --- | --- | --- |
| Single Responsibility | Group behavior that changes for the same owner and reason; make resource ownership explicit | A root or manager owns policy, protocol, persistence and cleanup |
| Open/Closed | Put a proven alternative behind a suitable contract and select it at the edge | Provider/platform switches spread through domain logic; speculative plugin frameworks |
| Liskov Substitution | Preserve preconditions, postconditions, failure semantics and guarantees for every implementation of the same contract | A weaker adapter returns success, an unsupported method is a no-op, or a receipt claims an unobserved fact |
| Interface Segregation | Give each consumer only the capabilities it needs through explicit dependency records | Generic dependency bags and interfaces forcing irrelevant lifecycle methods |
| Dependency Inversion | High-level policy owns the abstractions it needs; implementations depend on those abstractions | Application imports a concrete SDK, database client or container to find dependencies |

SOLID does not require classes, inheritance, one-method interfaces or one file
per function. Pure functions and concrete private helpers are often sufficient.
Open/Closed does not prohibit refactoring or correcting an existing contract;
it guides where changes belong and how compatibility is handled.

## DDD and DRY

Use strategic DDD to name real ownership boundaries and the language exchanged
between them. Use tactical DDD where aggregates, value objects and domain
services enforce real invariants. Define the owner of state, transactions,
identity and transitions. Do not invent ceremonial aggregates, empty layers,
generic repositories or a universal shared domain for infrastructure and tooling.

DRY means one authoritative source for the same knowledge: a policy, transition,
schema identity or configuration rule. Similar syntax is not enough to establish
shared semantics. Do not couple independent contexts to remove a few duplicated
lines. Extract a reusable abstraction after a second real consumer or a concrete
repeated need demonstrates its contract and owner. A concern expected to serve
several projects is designed as a library from the start; see
[library-first design](#library-first-design-and-deliberate-evolution).
Avoid unowned `shared` or `utils` dumping grounds.

Independent test oracles may intentionally state expected behavior separately
from production mappings. Generate mechanical representations from their one
authority, but do not generate both a decision and its expected answer from the
same implementation and call that independent evidence.

## Correctness, security and operations

- Validate untrusted input at the boundary; derive identity and authorization
  from trusted context. Workspace text, user payloads and tool output do not
  acquire authority merely by being present.
- Keep secrets in their owning adapters. Do not put credentials in source,
  prompts, logs, errors, artifacts or evidence. Use the approved authentication
  workflow and the least access needed for the task.
- Make concurrency, idempotency, deadlines, cancellation and resource ownership
  explicit when the operation needs them. A timeout does not prove that an
  external effect did not occur. Retry only with a demonstrated safe/idempotent
  contract; preserve uncertainty and reconciliation evidence otherwise.
- Separate an observed result from an asserted guarantee. Tests, configuration,
  manifests, signatures, authorization, enforcement and qualification prove
  different things. Do not fake receipts or silently downgrade an adapter.
- Preserve durable state, in-flight work and any compatibility commitment a
  repository has explicitly declared. Plan additive or otherwise reversible
  migrations, rollback and handling of in-flight state for changes that need
  them. Other contract changes may break deliberately under
  [library-first design](#library-first-design-and-deliberate-evolution).
  Cleanup must release only owned resources and report unresolved debt.
- Run effectful provider, agent, provisioning, terminal-runtime and recovery
  tests only in disposable or explicitly test projects and approved identities.
  Real user projects and irreversible external operations require the relevant
  explicit authorization. Do not repeat a permission request already covered
  by the current task's authorization.

## Change workflow and evidence

1. Identify the changed behavior, semantic owner, relevant decisions, API and
   dependency edges. For significant changes, state invariants, failure cases,
   compatibility and resource ownership before implementation. Follow the
   repository's decision process when a required choice is unresolved.
2. Deliver the smallest coherent working slice. Preserve maintainability,
   security, observability and a clear extension path. Avoid speculative
   infrastructure, empty scaffolding and unrelated refactors.
3. Use the repository's package manager and dependency policy. When adding or
   upgrading a dependency, verify its current stable release, compatibility and
   provenance. Retain approved versions, lockfiles and integrity evidence;
   freshness alone does not authorize an unrelated upgrade of a pinned protocol.
4. Test the changed contract and credible failure modes. Choose unit, property,
   integration, concurrency, migration or E2E tests according to the risk.
   Include rejecting fixtures for new enforced boundaries. Do not add tests
   that merely restate the implementation or unnecessary tests for simple prose.
5. Run the documented focused, fast and required final gates for that repository
   and changed surface. A narrow or fast check does not replace a required full
   gate. Do not prescribe one package manager or command to every repository.
   Reuse valid evidence bound to unchanged inputs; repeat checks when changes,
   failures or unresolved risk justify them.
6. Review semantic ownership as well as structural checks. Never get green CI
   by dropping governed roots, weakening assertions, adding blanket exclusions,
   disabling tests or claiming a missing/no-op gate as evidence.
7. Update the owning documentation and scoped adoption/enforcement records in
   the same delivery. Preserve immutable accepted documents and published
   standards; record an explicit successor when their rules need to change.
8. Report the actual result, exact source revision, relevant checks, limitations
   and remaining work. Mocks, compilation, a plan, a merged PR or a locally
   created file do not independently prove product E2E or deployment readiness.

Keep process proportional to a demonstrated risk. Do not add approval rituals,
passive cooldowns, repeated full CI on unchanged inputs or an abstract platform
for hypothetical use. Required gates and real external restrictions still apply.
Prefer small reviewable changes with independent rollback over a large mixed PR.

Owner-generated agent squash merges require the
[fresh owner PR actor guard](../scripts/merge-owner-pr.mjs): explicit repository,
PR, reviewed exact head, ordinary Conventional Commit subject and complete
body file with all issue references. Re-read the authenticated owner and live
open PR actor/head immediately before merge and independently verify the actual
merged PR and final commit identity/message afterward. A green SHA status alone
cannot establish PR-specific UI merge safety. Never reopen or merge Bot staging
PRs. External human contributions keep their existing PR and original
authorship through their contributor-preserving flow, outside owner squash.
The owner-only guard also inspects the complete head-bound source commit list;
an owner-opened PR containing another contributor's commit cannot use this flow.

Keep the canonical Actions PR creation/approval permission explicitly false at
the organization default and current repositories. Disabling creation may leave
a generated Changesets branch without a staging PR; the owner inspects it and
opens a PR with `gh` before a failed-run rerun/current-input attestation.

## Where the detailed rules live

| Topic | Canonical entrypoint |
| --- | --- |
| Feature ownership, layers and dependency mechanisms | [Feature Module Standard index](architecture/feature-module-standard/README.md) and [v1](architecture/feature-module-standard/v1.md); the consumer's local adoption profile owns its exact scope |
| Get Modular construction and consumer adoption, when applicable | [Consumer Module Standard](https://github.com/agent-teams-ai/get-modular/blob/main/docs/architecture/common-assembly.md#consumer-module-standard); use the consumer's reviewed pin |
| Reusable development tooling and checks | [Engineering Foundation](https://github.com/agent-teams-ai/engineering-foundation); repository profiles own applicability and actual commands |
| Commit and PR authorship | [Maintained owner policy](../GOVERNANCE.md#commit-and-pull-request-authorship) and [canonical identity/status rule](../governance/commit-author-identity.json); preserve external human authorship |
| Contributions and decisions | [Contribution rules](../CONTRIBUTING.md) and [governance boundaries](../GOVERNANCE.md) |
| Security reporting and organization defaults | [Security policy](../SECURITY.md) and [security baseline](organization-security-baseline.md) |
| Product architecture, best practices, runbooks and release requirements | The target repository's `AGENTS.md`, `CLAUDE.md`, README/documentation index, accepted ADRs and local profiles |

This file is a maintained common-practice baseline, not another immutable FMS
version or conformance engine. Changes that alter an adopted architectural
contract must go through that contract's version/adoption process. Central
guidance must not silently migrate a consumer or certify it.

GitHub does not automatically inject this policy into every agent session.
Repository instruction files must explicitly require reading the link. Fetch it
using the authorized GitHub access path (for Codex here, `gh` CLI). If it is
unavailable, use an explicitly identified retained revision when available,
report the access limitation, and continue only work whose applicable rules can
be established. Never invent the missing policy or claim to have read it.
