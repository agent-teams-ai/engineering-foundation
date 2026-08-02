# Scaffolding Compiler Protocol

Status: Active for the protocol kernel and testing-only conformance vertical.

[ADR-0006](../decisions/0006-closed-deterministic-scaffolding-compiler.md)
accepts this design. The closed protocol, public schemas, CLI, programmatic API,
memory adapter, journaled filesystem adapter, and testing-only conformance
definitions are implemented. Product recipes, structured-update operations, a
second consumer, and the Nx adapter are not implemented or qualified.

## Implementation status

The current vertical proves the execution protocol without inventing consumer
business architecture. It can materialize one non-product TypeScript testing
package through a closed built-in Composition and static definition registry.
It is conformance evidence, not a reusable bounded-context or feature recipe.

Available commands:

```bash
agent-teams-foundation scaffold-plan intents/example.yaml --consumer /repo --json
agent-teams-foundation scaffold-apply plans/example.json --consumer /repo --json
agent-teams-foundation scaffold-recover --consumer /repo --json
```

`scaffold-plan` reads the strict consumer configuration at
`architecture/foundation/scaffolding.yaml` by default. `--config` may select a
different repository-relative file. Apply executes only the exact final bytes
in a saved immutable Plan. Before writing, it independently recompiles the
expected Plan from the embedded normalized Intent and current consumer authority
and requires an exact digest match.
Recovery applies the same proof before it resumes a prepared journal. If the
current authority is unavailable or cannot reproduce the journal Plan exactly,
recovery fails without changing the journal or its outputs.

## Goals

- one deterministic scaffolding protocol for multiple repositories and tools;
- reusable technical recipes without copying consumer business architecture;
- safe, idempotent operation for coding agents and CI;
- exact previews and actionable machine-readable diagnostics;
- framework-neutral execution with optional Nx integration;
- incremental support for backend, frontend, Electron, SDK, infrastructure,
  testing, and future non-TypeScript workspaces;
- a stable evolution path for definitions and migrations.

## Non-goals

- a universal architecture or filesystem DSL;
- a product runtime framework or production dependency;
- generation of aggregates, entities, policies, or other business meaning;
- empty DDD layers or placeholder source presented as an accepted feature;
- a public third-party recipe, facet, template, or policy plugin ecosystem;
- remote templates, executable consumer configuration, or package installation;
- true multi-file filesystem atomicity;
- replacing Nx, package managers, compilers, formatters, or consumer validators.

## Vocabulary

The vocabulary is intentionally precise because `profile` and `preset` already
have other meanings across Agent Teams systems.

| Concept | Responsibility | Must not own |
| --- | --- | --- |
| `ScaffoldProfile` | One resolved technical environment such as language, module system, package manager, and framework boundary | Business topology, creation intent, deployment behavior |
| `Recipe` | One creation intent and its typed composition slots | Repository-wide defaults or unrelated optional concerns |
| `Facet` | One optional orthogonal contribution through recipe-declared slots | Arbitrary mutation, precedence, or implicit activation |
| `Composition` | Consumer-approved binding of profile, recipe, exact facet policy, parameters, and mandatory policies | New renderers or merge semantics |
| `Policy` | Blocking invariant over Intent, authority snapshot, Plan, workspace state, or Receipt | Defaults, generated files, or bypass switches |
| `Template` | Private pure renderer used by one released definition | Public selection, inheritance, policy, or runtime execution |
| `Preset` | Published static tool configuration such as TypeScript or Oxlint settings | Scaffolding composition semantics |

Use `ScaffoldProfile` in schemas and code. Bare `Profile` is too ambiguous with
deployment and runtime profiles.

## Ownership

```mermaid
flowchart LR
    Facts["Consumer-owned facts"] --> Adapter["Typed facts adapter"]
    Config["Consumer compositions"] --> Compiler["Foundation compiler"]
    Registry["Closed Foundation registry"] --> Compiler
    Adapter --> Snapshot["Immutable authority snapshot"]
    Snapshot --> Compiler
    Intent["Scaffold Intent"] --> Compiler
    Compiler --> Plan["Immutable Plan"]
    Plan --> Fs["Filesystem adapter"]
    Plan --> Nx["Optional Nx Tree adapter"]
    Fs --> Receipt["Truthful Receipt"]
    Nx --> Receipt
    Receipt --> Checks["Independent consumer checks"]
```

Foundation owns:

- strict public schemas and canonicalization;
- normalization, composition, diagnostics, hashing, and policy phases;
- the static definition registry and proven generic definitions;
- workspace ports, filesystem application, journaling, and recovery semantics;
- conformance fixtures and adapter parity tests.

A consumer owns:

- package and target catalogs;
- bounded contexts, feature ownership, terminology, and accepted evidence;
- local `ScaffoldProfile` bindings and approved `Composition` records;
- fixed/default parameters and additional monotonic policies;
- the final review and implementation of business behavior.

The optional Nx package owns only Nx `Tree` snapshot and apply translation. Nx
metadata is derived evidence and never another package or architecture catalog.

## Composition model

One Intent selects exactly one consumer-approved `Composition`. A Composition
resolves exactly one `ScaffoldProfile` and one `Recipe`. Facets are an
order-independent set constrained by the Composition.

Illustrative consumer configuration:

```yaml
schemaVersion: 1
projectId: agent-teams-orchestrator

sources:
  packageCatalog:
    format: agent-teams.package-catalog/v1
    path: architecture/package-catalog.yaml

scaffoldProfiles:
  orchestrator.typescript-context/v1:
    uses: agent-teams.typescript-package/v1
    fixedParameters:
      packageManager: pnpm
      moduleSystem: esm
    defaultParameters:
      tsconfigBase: tsconfig.json

compositions:
  context-first-slice/v1:
    scaffoldProfile: orchestrator.typescript-context/v1
    recipe: package-with-first-slice/v1
    targetRoles: [bounded-context]
    facets:
      fixed: [feature-owned/v1]
      allowed: [node-tests/v1, public-exports/v1]
      default: [node-tests/v1]
    policies:
      - catalog-target/v1
      - accepted-owner/v1
```

The identifiers are illustrative until a vertical slice accepts their exact
contracts. Consumer files refer to catalogs and evidence; they do not duplicate
resolved package paths, names, roles, or owner status.

### Parameters

- Profile, Recipe, and each Facet own separate closed parameter namespaces.
- Definition defaults apply first, then consumer defaults, then explicit Intent
  values.
- Consumer fixed parameters cannot be overridden.
- Unknown parameters and missing required parameters are invalid input.
- An Intent cannot supply output paths, templates, file content, policy
  exclusions, callbacks, or commands.

### Facets

- Facet declaration order has no semantic meaning.
- `requires` and `conflicts` are explicit versioned metadata.
- A required Facet is never silently enabled. Default and fixed expansion is
  visible in the normalized Plan.
- One file path has one base producer. Multiple byte-identical claims may
  deduplicate only when the relevant definition contract explicitly permits it.
- Structured contributions merge by stable semantic key through a
  Foundation-owned codec. Unequal duplicate keys, ordering cycles, and
  unsupported collisions fail.
- Last-write-wins, numeric priority, deep object overlays, and free-form text
  patches are prohibited.

### Policies

Policies are monotonic. Kernel, Profile, Recipe, Facet, and consumer policies are
unioned. A consumer may add or strengthen a policy but cannot remove, reorder,
downgrade, or suppress a stronger policy required by a selected definition.

## Public protocol

JSON Schema Draft 2020-12 is canonical. `Intent`, `Plan`, `Receipt`, and each
component parameter contract have independent immutable schema versions. Every
object closes unknown properties.

### Intent

An Intent contains:

```text
schemaVersion
compositionId
targetRef
normalized user parameters
explicit optional Facets
```

`targetRef` is a consumer catalog identity, never an arbitrary filesystem path.
The consumer adapter resolves it into an immutable authority snapshot before
compilation.

### Plan

A Plan contains:

```text
schemaVersion
compiler identity and version
consumer authority source paths
normalized source Intent
Intent digest
authority snapshot digest
definition identities, contract versions, and contract digests
normalized selection, resolved parameters, and passed policy evidence
complete read set and preconditions
required adapter capabilities
operations with exact final bytes, modes, and result digests
stable diagnostics
Plan digest
```

The Plan stores final bytes, not template references, AST callbacks, patch
functions, or formatter instructions. Apply never renders output from a newly
compiled Plan. It recompiles only as an authority proof and rejects the supplied
Plan unless the installed exact Foundation version and closed registry produce
the same digest from current facts.

A definition `contractDigest` covers its closed declarative contract. The
compiler package version identifies the released executable implementation, and
the operation digests bind the actual output bytes. A consumer cannot provide
or replace executable definition behavior.

Canonical JSON uses the NFC-normalized, safe-integer subset of RFC 8785 JCS and
SHA-256 digests. Semantic sets are sorted before canonicalization; genuinely
ordered collections remain ordered. Digested documents omit their own digest
field. Timestamps, absolute paths, locale-dependent values, environment data,
randomness, and secrets are absent.

### Receipt

A Receipt contains:

```text
schemaVersion
Plan digest
adapter identity and contract version
outcome
commit and recovery classification
per-operation precondition outcome and result digest
stable diagnostics
Receipt digest
```

Receipt outcomes distinguish at least:

```text
applied
already-applied
rejected
failed-recovered
recovery-required
```

An operation with `not-applied` or `conflict` has no result digest. Receipts do
not claim a desired post-image that was not observed or published.

The filesystem adapter reports journaled recoverability. The Nx adapter reports
host-managed commit semantics and cannot claim Foundation-owned durable recovery.

## Compilation and apply

The compiler is pure over the Intent, authority snapshot, registry definitions,
and immutable workspace snapshot. It reads no ambient working directory, clock,
randomness, process environment, network, or mutable global registry.

Before applying, an authority-bearing durable adapter must:

1. verify schemas, Plan and operation digests, and required capabilities;
2. acquire the repository-scoped cooperative mutation lock;
3. recompile any nonterminal Foundation journal from its embedded Intent and
   current consumer authority before it can publish or recover output;
4. preserve that journal and its outputs unchanged when this provenance cannot
   be proven;
5. reconcile only a journal whose exact Plan is reproduced by the closed
   compiler;
6. recheck the authority read set and compile the exact expected Plan with the
   installed compiler version from the embedded Intent, current consumer
   configuration, current catalog, and closed registry;
7. reject the supplied Plan unless that expected Plan has the same digest;
8. recheck every operation precondition;
9. reject path traversal, symlink or reparse escape, case-fold collision,
   protected roots, special files, and unsafe modes;
10. recognize an exact desired post-image as idempotently satisfied;
11. reject any third state rather than overwrite it.

The in-memory adapter is a non-durable conformance workspace without an external
consumer authority boundary. It validates the self-contained Plan and adapter
capabilities; the durable filesystem adapter additionally performs steps 2-9.

Version 1 materializes files only. It has no delete, move, fuzzy patch, wildcard
precondition, or overwrite-any-state operation. Updates to existing structured
documents require a later proven operation contract. Such updates compile to
exact post-images and CAS preconditions; Apply still performs no parsing.

For filesystem execution, a durable journal records preconditions and final
images before publication. Writes use same-directory temporary files, digest
verification, and deterministic order. A process crash may leave partial files
until mandatory recovery; the system does not claim true multi-file atomicity.
Recovery first reloads the journal's consumer authority and must reproduce the
exact Plan through the closed compiler. If it cannot, the journal and outputs
remain untouched. Recovery never overwrites a third-party edit that no longer
matches the planned post-image.

## Security boundary

Scaffolding is a trusted development tool operating on untrusted repository
state. Version 1 permits no:

- network access or remote assets;
- environment interpolation or implicit `cwd`;
- shell commands, package installation, or lifecycle scripts;
- consumer JavaScript, dynamic imports, callbacks, or executable hooks;
- public template inheritance, includes, helpers, or arbitrary template paths;
- `--force`, `--skip-architecture`, silent fallback, or policy suppression;
- writes outside the explicit repository root or approved target scope.

The cooperative lock is not a sandbox against a hostile process with the same OS
identity. CAS, path containment, and recovery protect correctness against normal
concurrent tools, crashes, and stale Plans. A stronger hostile-writer model
requires a separate threat-model decision and a platform adapter with
descriptor-relative filesystem primitives unavailable in the portable Node.js
API. Current conformance covers pre-existing symlinks or reparse paths and
cooperative concurrent writers, not adversarial same-identity ancestor swaps.

## Applicability

The protocol is universal; project concepts are not. Profiles and proven
definitions can support different shapes without forcing one architecture:

| Consumer shape | Possible profile-owned behavior |
| --- | --- |
| Complex bounded context | Real feature slice with selected domain, application, process, persistence, contract, and test Facets |
| SDK | Contract, client, mapping, export, and conformance Facets; domain Facet prohibited |
| Integration adapter | External contract plus consumer-owned port and mapping; no invented domain model |
| Electron feature | Explicit shared, main, preload, renderer, IPC, and test placement as required by that consumer |
| CLI or application host | Thin command and composition output; business behavior and repositories prohibited |
| Platform tooling | Development-only capability, schema, CLI adapter, and fixture output |
| Tests | Colocated or dedicated conformance output according to consumer policy |
| Rust component | Future Cargo-aware Profile and codecs over the same language-neutral Plan |

Full DDD is therefore a consumer-selected, evidence-backed composition for
complex business contexts, not a default hidden in the compiler.

## Package boundary

The first implementation remains a feature inside
`@agent-teams/engineering-foundation`. Splitting contracts, kernel, definitions,
and adapters into several packages before independent consumers or dependency
lifecycles require it would add release and local-link complexity without a real
boundary.

Nx integration is the exception because `@nx/devkit` is an independent optional
dependency. When implemented, `@agent-teams/engineering-foundation-nx` uses an
evidence-backed peer range while each tested workspace pins one exact Nx version.
The adapter and Foundation kernel initially release as one Changesets fixed group.

## Delivery stages

These are qualification stages, not a requirement to prebuild every definition.
The current release implements Stage 0 only. Product donors, additional
scenario fixtures, a second consumer, and Nx remain later gates.

### Stage 0: protocol kernel and testing conformance

- publish the target ADR, closed schemas, CLI, and programmatic API;
- define canonicalization, diagnostics, policy union, definition compatibility,
  and capability negotiation;
- build the pure compiler, strict in-memory adapter, filesystem apply, lock,
  CAS, journal, recovery, and adversarial fixtures;
- provide a golden Intent, Plan, and Receipt vector for the testing-only
  conformance Composition;
- document anticipated backend, SDK, integration, Electron, tooling, and
  Rust-shaped applicability without publishing speculative definitions.

### Stage 1: first proven product vertical

- select a manually accepted donor vertical rather than generating placeholder
  business behavior;
- encode only the reusable Profile, Recipe, Facets, and Policies proven by that
  donor;
- compare normalized donor and Foundation Plans in dual-run mode.

The existing orchestrator package-only scaffolder is useful evidence but is not
the accepted reusable recipe because its output intentionally requires a real
feature to become valid.

### Stage 2: second consumer

- prove the same protocol against a materially different Platform or Agent
  Runtime vertical;
- extract only definitions that remain genuinely reusable;
- keep consumer-specific topology and policies local.

### Stage 3: Nx adapter

- publish the separate optional adapter only after memory and filesystem
  semantics are stable;
- prove byte-for-byte Plan parity and explicit host-managed Receipt semantics;
- prohibit Nx formatters, installers, or generators from changing bytes after
  Plan hashing.

### Stage 4: expansion and migration

- add backend, SDK, integration, Electron, application-host, and test definitions
  one accepted vertical at a time;
- add Rust/Cargo support only after real cases prove the codecs and workspace
  boundary;
- keep scaffolding replay separate from migration;
- introduce replace, move, delete, reconcile, or public extension contracts only
  through later evidence and, where semantics change, a new ADR or protocol
  version.

## Conformance

Every released vertical or adapter must cover:

- strict-schema positive and adversarial fixtures;
- Facet permutation and conflict tests;
- compile-twice byte equality and stable Plan digests;
- apply-twice idempotency;
- stale Plan and concurrent writer rejection;
- pre-existing symlink or reparse escapes, path escapes, case collisions, and
  Windows reserved names;
- injected failure at every journal and file publication phase;
- crash/restart recovery in disposable sandbox repositories;
- memory, filesystem, and Nx Plan parity where applicable;
- package tarball and registry-mode consumer E2E verification;
- independent consumer architecture checks after Apply.

Real user projects are never used for destructive or crash-injection tests.

The current testing vertical additionally fixes a committed protocol-v1 golden
digest vector and proves strict input rejection, Facet permutations,
`requires`/`conflicts`, mandatory policy union, compile-twice equality,
apply-twice idempotency, current-authority recompilation, third-state rejection,
publication-phase process death, deterministic recovery, package tarball use,
and compilation of generated TypeScript. This evidence qualifies only the
closed testing definitions and memory/filesystem adapters that exist today.

## Evolution rules

- npm package versions, envelope schemas, parameter schemas, definition
  revisions, and adapter compatibility are separate version axes;
- immutable schemas remain inspectable for the documented compatibility window;
- an upgrade never enables definitions or changes a consumer Composition
  automatically;
- exact dependency pins and Renovate PRs carry upgrades through complete consumer
  conformance;
- generated output is ordinary consumer-owned source after Apply; Receipts are
  evidence, not permanent ownership or drift locks;
- new recipes and Facets do not require a protocol version when existing
  semantics express them safely;
- breaking apply semantics or trust-boundary changes require a new protocol
  version and migration guidance.
