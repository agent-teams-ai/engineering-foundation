# Engineering Foundation Documentation

This directory separates decisions, target architecture, development procedures,
and release operations. Navigation files point to canonical documents; they do
not repeat their rules.

## Canonical documents

| Subject | Document | State |
| --- | --- | --- |
| Foundation ownership | [Ownership boundary](architecture/ownership.md) | Active |
| Executable capability model | [Executable capabilities](architecture/executable-capabilities.md) | Implemented and released; consumer activation is explicit |
| Documentation integrity | [Executable capabilities](architecture/executable-capabilities.md#documentation-governance) | Accepted and implemented |
| Contract evolution | [Executable capabilities](architecture/executable-capabilities.md#contract-evolution) | Accepted and implemented |
| Suppression governance | [Suppression governance](architecture/suppression-governance.md) | Accepted and implemented |
| Executable specifications | [Executable specifications](reference/executable-specifications.md) | Accepted and implemented; activation is explicit |
| Public API compatibility | [Public API compatibility](architecture/public-api-compatibility.md) | Accepted and implemented; consumer mutation gate required |
| Repository security | [Repository security baseline](security/repository-security-baseline.md) | Accepted and implemented for publishing repositories |
| Consistency evidence gate | [Consistency evidence gate](architecture/consistency-evidence-gate.md) | Accepted target; implementation pending |
| Scaffolding compiler | [Scaffolding compiler protocol](architecture/scaffolding-compiler-protocol.md) | Kernel and generic Node TypeScript library recipe implemented; Nx deferred |
| Document authoring | [Document authoring protocol](architecture/document-authoring-protocol.md) | Catalog, Plan compiler, create-only writer, doctor, and exact-version recovery released in Docs Protocol 0.1.2 |
| Unified documentation UX | [ADR-0026](decisions/0026-retain-only-document-directory-materialization.md#carried-forward-adr-0025-decisions) | Stable Docs Protocol cohort adopted by current consumers; legacy compatibility retirement remains evidence-gated |
| Open-source documentation | [Open-source Docs Protocol](reference/open-source-docs-protocol.md) | Portable bootstrap, agent context, and optional read-only MCP implemented; release qualification in progress |
| Managed consumer upgrades | [Managed Docs Protocol consumer integration](architecture/managed-docs-consumer-integration.md) | Qualified Cohort authority, pins, lockfile, assets, activation, and rollback are one staged command |
| Managed consumer integration | [Consumer integration](architecture/managed-docs-consumer-integration.md) | Implemented and release-qualified; consumer rollout remains explicit |
| Document authoring security | [Cooperative writer threat model](security/document-authoring-threat-model.md) | Cooperative-writer boundary implemented and released; registry qualification complete |
| Node TypeScript library recipe | [Recipe reference](reference/node-typescript-library-boundary.md) | Implemented; qualification remains consumer-owned |
| Local package development | [Local mode](development/local-mode.md) | Active |
| Consumer adoption | [Consumer adoption](development/consumer-adoption.md) | Active |
| Dependency declaration rules | [Rule reference](reference/workspace-dependency-declarations.md) | Active |
| Portable agent workflow | [Agent workflow](reference/repository-agent-workflow.md) | Implemented and dogfooded; activation is explicit |
| Deterministic quality gates | [Quality gate runner](reference/quality-gate-runner.md) | Implemented and post-build dogfooded; activation is explicit |
| Quality gates | [Quality gates](development/quality-gates.md) | Active |
| Maintainability budgets | [Budget evaluation](research/maintainability-budget-evaluation.md) | Implemented and dogfooded; consumer adoption remains opt-in |
| DeepSeek Harness tooling comparison | [Strict comparison](research/deepseek-harness-tooling-comparison.md) | Revalidated; selected adaptations adopted |
| Agent architecture standard | [Design study](research/agent-architecture-standard-design.md) | Incubation direction accepted by ADR-0036; normative authority moves to the dedicated repository |
| Agent architecture standard delivery | [Implementation plan](research/agent-architecture-standard-implementation-plan.md) | Accepted overlay-first vertical plan; irreversible contracts remain gated by neutral ADRs and conformance |
| Agent architecture standard decisions | [Product decision brief](research/agent-architecture-standard-product-decisions.md) | D0-D11 accepted; D5 resolved overlay-first and D9 selects public non-latest RCs |
| Agent architecture standard D5 evidence | [Operation spike](research/agent-architecture-standard-operation-spike.md) | Complete; independent adversarial review rejected three initial public operations |
| Foundation architecture readiness | [Independent audit](research/foundation-architecture-audit-2026-08-23.md) | Revalidated at 8.8/10; remaining migrations governed by ADR-0035 |
| Source parser evidence | [Parser spike](research/source-dependency-parser-spike.md) | Implemented; decision accepted |
| Governance capability acceptance | [Acceptance review](research/governance-capability-acceptance-review.md) | Complete |
| Package release | [Release](release.md) | Active |
| Architecture decisions | [Decision index](decisions/README.md) | Active |

## Document roles

- `decisions/` records why a consequential choice was made and what it
  supersedes. Accepted decisions are immutable; a later decision supersedes
  rather than silently rewriting them.
- `architecture/` owns the current target design and engineering invariants.
- `development/` owns contributor workflows that are true today.
- `reference/` explains stable executable rules. Immutable JSON schemas shipped
  by the package remain the source of truth for public data contracts.
- `research/` records reproducible evidence for an open decision. Research may
  recommend an option but cannot silently accept an ADR.

Every target document must state whether it is implemented. A target design must
not be presented as an available command or package API before conformance proves
it.
