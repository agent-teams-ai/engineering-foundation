# Executable Capabilities

Status: Implemented and released for workspace declarations, source dependencies,
suppression governance, public API compatibility, and repository security.
The additional documentation and contract capabilities, hardened source graph,
portable repository agent workflow, and closed scaffolding protocol are also
implemented in the current published package.

ADR-0001 accepts this model. Version 0.2 replaces `foundation.config.mjs` with
strict `foundation.config.yaml` and implements the first capability. The source
dependency capability is implemented and dogfooded behind internal ports.
ADR-0002 accepts its Oxc adapter after cross-platform conformance evidence.
ADR-0003 through ADR-0009 accept the governance, source-graph,
documentation, contract-evolution, and workflow-security capabilities.
ADR-0016 supersedes ADR-0015 and hardens contract evolution with a reusable
pinned Buf `FILE` qualification producer and versioned evidence envelope.
Package installation never activates them: the consumer declares each applicable
capability and supplies its own policy and qualification evidence.

## Capability lifecycle status

These terms describe different facts and must not be used interchangeably:

- **implemented** means executable code and conformance fixtures exist in this
  repository;
- **released** means the implementation is present in the current published npm
  package;
- **dogfooded** means this repository declares and executes the capability;
- **consumer-enabled** means a consuming repository declares the capability in
  its own `foundation.config.yaml` with consumer-owned policy and evidence.

| Capability | Implemented | Released | Dogfooded here | Consumer activation |
| --- | --- | --- | --- | --- |
| `workspace.dependency-declarations` | Yes | Yes | Yes | Only by explicit declaration |
| `architecture.source-dependencies` | Yes | Yes | Yes | Only by explicit declaration |
| `quality.suppression-governance` | Yes | Yes | Yes | Only by explicit declaration |
| `quality.executable-specifications` | Yes | Yes, since 0.10.0 | No donor catalog owned here | Only by explicit declaration after consumer qualification |
| `package.public-api-compatibility` | Yes | Yes | Yes | Only by explicit declaration and release-owned baselines |
| `repository.security-baseline` | Yes | Yes | Yes | Only for an applicable publishing repository |
| `documentation.local-references` | Yes | Yes | Yes | Only by explicit declaration |
| `governance.architecture-decisions` | Yes | Yes | Yes | Only by explicit declaration and baseline promotion |
| `contract.protobuf-evolution` | Yes | Yes | No contract owned here | Only by explicit declaration and qualification evidence |
| `contract.json-schema-releases` | Yes | Yes | No contract owned here | Only by explicit declaration and consumer evidence |
| `repository.agent-workflow` | Yes | Yes | Yes | Only by explicit declaration |

Installing or upgrading the package changes none of the consumer activation
cells. Each consumer records its own activation status in its repository.

## Goals

- one versioned implementation of reusable engineering policy;
- consumer-owned architecture facts and exceptions;
- deterministic output for CI, tools, and coding agents;
- feature-owned capability slices with strict dependency direction;
- internal implementation freedom without accidental public plugin contracts;
- an extraction path that proves semantic parity before deleting donor code.

## Non-goals

- a product runtime framework or dependency;
- a universal architecture DSL;
- a third-party plugin ecosystem;
- a replacement for package managers, compilers, Nx, or specialized linters;
- consumer business concepts, bounded-context catalogs, or authorization policy;
- affected-only checks as a substitute for complete CI coverage.

## Ownership and flow

```mermaid
flowchart LR
    Root["foundation.config.yaml"] --> Loader["Strict config loader"]
    Facts["Consumer-owned capability facts"] --> Adapter["Capability adapter"]
    Loader --> Registry["Private closed registry"]
    Registry --> UseCase["Capability use case"]
    Adapter --> IR["Normalized immutable input"]
    Scanner["Foundation-owned scanner"] --> IR
    IR --> Policy["Pure policies and specifications"]
    UseCase --> Policy
    Policy --> Report["Canonical deterministic report"]
    Report --> Text["Human renderer"]
    Report --> JSON["JSON renderer"]
```

Foundation owns loaders, scanners, normalized technical models, generic policy
evaluation, rule metadata, diagnostics, and rendering. A consumer owns package
identities, paths, roles, allowed edges, source roots, intentional exceptions,
and project-specific fixtures. Foundation must not contain names such as `Team`,
`Run`, a consumer's bounded-context roles, or a reserved organization scope.

## Capability boundaries

Capability identifiers describe one cohesive policy surface. They are not menu
categories.

### `workspace.dependency-declarations`

The first implementation validates declared workspace dependency state:

- workspace membership and unique package names;
- local package references through the package manager's workspace protocol;
- external dependency declarations through the accepted central version source;
- exact versions in the accepted catalog when consumer policy requires them;
- legal dependency sections and development-only tooling placement.

Version 1 supports pnpm through an internal adapter selected explicitly by the
capability configuration. The capability ID remains policy-oriented; support for
another package manager requires a proven second adapter, not speculative generic
interfaces in the public API.

### `architecture.source-dependencies`

The second implementation validates observed source relationships:

- package imports agree with declared and consumer-allowed edges;
- cross-package relative imports cannot bypass package boundaries;
- imported package subpaths are exported;
- unsupported or unresolvable governed imports fail closed.
- the single source-dependency schema requires declared target entrypoints for
  cross-boundary local imports;
- boundary and package cycles are checked separately for runtime and type-only
  edges over one normalized immutable observed graph.

Each boundary may explicitly set `dependencyMode: development` when the entire
boundary is consumer-owned tooling or test/specification source. Omitted or
`runtime` mode preserves the fail-closed default. A development boundary may
runtime-import an allowlisted package declared in the importing workspace
package's `devDependencies`; undeclared and non-allowlisted packages remain
violations, while allowlisted production dependencies remain valid.
Runtime boundaries may never import a development boundary, even through an
otherwise allowed edge. This prevents a runtime boundary from reaching
development dependencies through a wrapper or a longer boundary chain.
Package-name imports are fenced conservatively: when any observed source in a
target workspace package belongs to a development boundary, runtime boundaries
cannot import that package, including through type-only imports. The v1 graph
does not claim exact export-to-boundary ownership, so mixed runtime/development
packages must split development source into a separate package or keep imports
inside development boundaries. A future contract may add explicit, validated
export-to-boundary mapping rather than infer subpath ownership.

The source scanner, resolver, source-tree reader, and workspace inventory sit
behind separate internal ports. Exact Oxc 0.142.0 is the accepted outbound parser
adapter after comparison with a TypeScript 6 oracle. Parser-native types never
cross into application policy or public contracts.

Documentation ownership, DDD feature layout, LikeC4, security classification,
reliability catalogs, and scaffolding are separate capabilities or remain local
consumer checks. They cannot be added to either dependency capability.

### Governance capabilities

- `quality.suppression-governance` owns exact temporary inline waivers;
- `package.public-api-compatibility` owns released TypeScript API evidence,
  Changeset classification, and breaking-change approval;
- `repository.security-baseline` owns workflow least privilege, immutable action
  references, dependency/SBOM gates, and static publishable-package metadata for
  repositories that publish packages. Real tarball qualification is a separate
  consumer publication gate.

Each remains an independent feature slice with its own model, ports, policies,
adapters, schema, rules, and fixtures.

### Executable specifications

`quality.executable-specifications` validates a consumer-owned JSON catalog that
connects domain schemas and documents, optional generated types, owner
documents, ADRs, and distinct property and mutation gate bindings. A
type-generation gate is required exactly when generated types are declared. The
optional v1 state-model evidence profile is deliberately XState-shaped: it
requires an explicit, possibly empty list of unique consumer-declared axis
identifiers plus model, adapter, trace, diagram, and a distinct spec-model gate.
Axis identifiers are opaque connectivity data; Foundation does not infer
independence, meaning, or model parity from them. It reuses the contract JSON
Schema capability's strict Draft 2020-12 local-only Ajv inspection.

All catalog and selected workspace-manifest paths use the capability's
conservative portable ASCII segment contract and one cross-role identity map.
Aliases and platform-invalid paths fail before consumer artifact reads.

Foundation performs no process execution, imports no consumer model, has no
XState dependency, and owns no XState runtime or domain semantics. It makes no
claim that a bound gate passed. Domain facts, evaluators, properties, mutation
setup, state models, and execution evidence remain consumer-owned. Supporting a
different state-model formalism requires a versioned contract extension with
its own qualified evidence profile; v1 does not pretend that its XState-shaped
profile is generic. See the
[reference contract](../reference/executable-specifications.md).

### Documentation governance

- `documentation.local-references` validates CommonMark/GFM links, images,
  definitions, directory indexes, GitHub anchors, containment, and symlink
  safety;
- `governance.architecture-decisions` validates ADR identity, lifecycle,
  supersession, index membership, and immutable accepted-decision baselines.

The Markdown AST and slugger live only in an outbound adapter. Product-specific
headings, terminology, code anchors, catalogs, and diagrams remain in the
consumer repository. A documentation website or visual search surface is not a
foundation concern and requires explicit product-owner approval.

### Contract evolution

- `contract.protobuf-evolution` validates deterministic Buf release evidence;
- `contract.json-schema-releases` validates strict draft 2020-12 schemas,
  local-only references, positive and negative fixtures, immutable release
  digests, and supported-consumer evidence.

Normal checks never start Buf, a shell, or a network request. Qualification tools
run in explicit pinned CI boundaries and produce evidence consumed by the pure
capability. The capability proves evidence consistency, while the consumer's
protected qualification workflow owns evidence provenance. Breaking Protobuf
evidence must bind its exact fingerprint to an ADR in the immutable accepted
decision baseline.

The single Foundation-owned Protobuf configuration schema `v1` declares the
module, exact Buf configuration,
released descriptor and evidence locations. The explicit
`protobuf-qualify-breaking` command verifies the pinned Buf version, enforces the
exact `FILE` policy, builds the candidate descriptor and runs compatibility
against the released descriptor. Its versioned envelope binds all input digests,
canonical invocation semantics and normalized findings. Check mode reruns the
producer and rejects any byte-level evidence drift; normal capability execution
only validates the committed envelope and never starts a process.

## Internal package shape

Capabilities remain feature-owned inside the existing public package:

```text
src/
  composition/
    capability-registry.ts
  capabilities/
    workspace-dependency-declarations/
      contract/
      application/
        model/
        policies/
        ports/
      adapters/
        inbound/cli/
        outbound/config/
        outbound/pnpm-workspace/
      testing/
      module.ts
    source-dependencies/
      contract/
      application/
        model/
        policies/
        ports/
        use-cases/
      adapters/outbound/
      module.ts
  workspace-inventory/
    application/
    adapters/outbound/
```

Do not create a large shared `capability-runtime` hierarchy before a second
capability proves what is genuinely common. Minimal report and invocation types
may live in a small internal module. A capability becomes a separate workspace
package only when independent dependencies, consumers, or release cadence prove
the need.

## Configuration contract

The target root is `foundation.config.yaml`:

```yaml
schemaVersion: 1
project:
  id: consumer-repository
capabilities:
  workspace.dependency-declarations:
    configPath: architecture/foundation/dependency-declarations.yaml
```

Configuration rules:

- capability presence means enabled; disabled placeholders are prohibited;
- root and capability schemas are versioned independently;
- JSON Schema Draft 2020-12 is canonical and every object closes unknown
  properties;
- duplicate YAML keys, aliases, merge keys, custom tags, and environment
  interpolation are prohibited;
- config paths use repository-relative POSIX syntax and cannot be absolute,
  contain `..` or backslashes, or escape through a symlink;
- capability configuration is data, never executable consumer code;
- configuration loaders resolve paths from an explicit consumer root, never an
  ambient or hosting-wide working directory.

The exact dependency-declaration schema is an implementation deliverable. It
must separate package-manager input from consumer policy rather than expose pnpm
objects as domain models.

Schemas are the single source for public data shape. Loaders validate unknown
input against the schema before explicitly mapping it into a capability-owned
normalized internal model. Internal models are not hand-maintained mirrors of the
wire shape. The package ships immutable versioned files, conceptually:

```text
schemas/
  foundation-config/v1.schema.json
  foundation-check-report/v1.schema.json
  workspace-dependency-declarations/v1.schema.json
```

Explicit package exports and `agent-teams-foundation schema <schema-id>` expose
the same files. Any future public TypeScript contract types must be generated or
mechanically proven against those schemas; independently maintained duplicate
wire types are not allowed. A convenient unversioned alias may exist for humans,
but committed consumer configuration references a versioned schema.

## Public report contract

JSON is the canonical result. Text output renders the same report and cannot
invent separate state. The command always returns one aggregate report, even
when the caller selects only one capability. This avoids a future output-shape
change when repositories enable multiple capabilities.

```text
FoundationCheckReport
  reportSchemaVersion
  foundationVersion
  coverage: full | selected
  outcome: passed | violations | invalid-input | failed | cancelled
  summary
  capabilities[]
  problem?

CapabilityReport
  capabilityId
  capabilityConfigSchemaVersion
  outcome: passed | violations | invalid-input | failed | cancelled
  summary
  diagnostics[]
  problem?
```

Summary objects contain explicit counts by outcome and severity. An execution
problem contains a stable code, bounded safe message, phase, and retryable flag;
it never substitutes for a policy diagnostic.

Each diagnostic contains:

```text
ruleId
severity
subject
message
location: repository-relative POSIX path and optional 1-based range
relatedLocations[]
evidence
remediation
requiresArchitectureReview
```

`ruleId` is stable and semantic, for example
`workspace.dependency-declarations.external-version-not-cataloged`. An ID is
retired rather than reused with different meaning. `subject` identifies the
violated semantic object without depending on an absolute line number, enabling
stable parity comparison and future versioned fingerprints. Human wording may
improve without changing rule identity.

Capability reports sort by capability ID and diagnostics sort by rule ID,
semantic subject, path, and range. Configuration declaration order and I/O
scheduling cannot change output. Reports contain no timestamps, absolute paths,
stack traces, credentials, raw environment values, or unbounded source excerpts.
JSON mode writes one aggregate report to stdout; incidental logging cannot
corrupt the stream.

`coverage: full` means every capability declared by the consumer was selected.
An explicit capability argument reports `coverage: selected`, including when
selection fails before capability execution. Consumers must never treat a
`selected` report as complete repository evidence.

Every CLI invocation that requests JSON writes exactly one JSON value to stdout,
including argument parsing and command-launch failures. Non-document commands
use the versioned `foundation-command-error/v1` envelope; document commands keep
their command-specific versioned envelopes.

Each rule's ID and metadata are declared once in its owning capability. The same
registry powers diagnostics, generated reference material, and:

```text
agent-teams-foundation explain <rule-id> --format text|json
```

Rule metadata includes rationale, default severity, remediation guidance, and
the authoritative documentation location. Consumer configuration cannot silently
downgrade a blocking rule.

## Invocation and failure semantics

```text
agent-teams-foundation check
agent-teams-foundation check workspace.dependency-declarations
```

Exit codes are stable:

- `0`: all selected capabilities passed;
- `1`: policy violations were found;
- `2`: invocation, configuration, or governed input is invalid;
- `3`: environment or internal execution failed;
- `130`: execution was cancelled.

Aggregate precedence is cancellation, internal failure, invalid input, policy
violation, then success. Cancellation returns `130`; otherwise any internal
failure returns `3`, any invalid input returns `2`, and any violation returns `1`.
The aggregate outcome follows the same precedence.

Invalid or unreadable governed input never becomes a partial success. The root
configuration is validated before capability execution. Policy evaluation
collects all bounded diagnostics instead of failing on the first violation.
After valid root configuration, independent declared capabilities continue when
one capability reports violations or capability-local invalid input. Capabilities
cannot consume another capability's report or rely on incidental execution order.
A shared read-only snapshot may be extracted internally only after repeated
parsing cost or drift is measured.

Normal capability checks are read-only and use no network, shell, or subprocess.
Explicit baseline-promotion commands are separate write paths; they perform
atomic adapter-local replacement only after complete evidence passes.
Their Git ownership differs by semantic owner: accepted-decision baselines are
promoted in the reviewed architecture change that accepts the ADR, while
released contract and public-API baselines remain writable only by the trusted
release workflow. Historical ADR digests still prohibit mutation or deletion.
Checks accept `AbortSignal`, bound input, reject path ambiguity, and sort results
independently of scheduling. Linux and Windows behavior must match.

## Exceptions and suppressions

Inline suppression governance is active. Its exact waiver contract and
non-waivable rule classes are defined in
[Suppression governance](suppression-governance.md). Capability diagnostics have
no inline suppression mechanism.

## Compatibility and release policy

These versions are independent:

- npm package version;
- root configuration schema version;
- capability configuration schema version;
- report schema version;
- versioned diagnostic fingerprint algorithm, when introduced.

Exact consumer dependency pins make upgrades explicit. Patches preserve schema
and rule meaning. New capabilities or rules require an upgrade note and
conformance evidence. A breaking schema publishes a new schema version and a
migration guide; existing immutable schemas remain available for the supported
migration window.

Before version 1.0, an intentional public breaking change increments the minor
version. After version 1.0 it increments the major version. Stable rule IDs are
not changed merely to fit package SemVer.

## Extraction and conformance

The first capability follows this sequence:

1. define strict schemas, report fixtures, rule metadata, and adversarial
   positive and negative repositories;
2. implement pure policies and capability-specific adapters;
3. run the foundation validator and donor validator in advisory dual-run mode;
4. compare normalized `ruleId + subject + location`, never rendered strings;
5. prove parity on materialized fixtures and a real consumer;
6. make the foundation capability blocking while retaining the donor oracle for
   a short observation window;
7. delete only the superseded donor rules, leaving consumer-specific topology
   validation local;
8. pass package tarball, public registry, local attach/detach, Windows, Linux, and
   consumer conformance checks;
9. publish version 0.2 only after registry installation reproduces the same
   result.

A green run against the current orchestrator alone is insufficient because its
package catalog is largely reserved and does not yet materialize the future
product graph.

## Deferred work

- affected execution, persistent cache, and watch mode;
- SARIF conversion and versioned partial fingerprints;
- autofix;
- product scaffolding recipes, structured-update operations, and the optional Nx
  adapter. The closed kernel, schemas, commands, memory/filesystem adapters, and
  testing-only conformance vertical accepted in
  [ADR-0006](../decisions/0006-closed-deterministic-scaffolding-compiler.md) are
  implemented;
- public programmatic evaluation API;
- dynamic or third-party capabilities;
- generated production registries.

The JSON report keeps future SARIF conversion possible: SARIF requires stable
rule identifiers and recommends versioned partial fingerprints that avoid
absolute line numbers. The native foundation report remains smaller and
agent-oriented until a real SARIF consumer exists.

## External standards

- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
- [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)
- [pnpm catalogs](https://pnpm.io/catalogs)
- [pnpm workspace protocol](https://pnpm.io/workspaces#workspace-protocol-workspace)
