# Engineering Foundation Documentation

This directory separates decisions, target architecture, development procedures,
and release operations. Navigation files point to canonical documents; they do
not repeat their rules.

## Canonical documents

| Subject | Document | State |
| --- | --- | --- |
| Foundation ownership | [Ownership boundary](architecture/ownership.md) | Active |
| Executable capability model | [Executable capabilities](architecture/executable-capabilities.md) | Five capabilities active |
| Suppression governance | [Suppression governance](architecture/suppression-governance.md) | Accepted and implemented |
| Public API compatibility | [Public API compatibility](architecture/public-api-compatibility.md) | Accepted and implemented; consumer mutation gate required |
| Repository security | [Repository security baseline](security/repository-security-baseline.md) | Accepted and implemented for publishing repositories |
| Consistency evidence gate | [Consistency evidence gate](architecture/consistency-evidence-gate.md) | Accepted target; implementation pending |
| Local package development | [Local mode](development/local-mode.md) | Active |
| Consumer adoption | [Consumer adoption](development/consumer-adoption.md) | Active |
| Dependency declaration rules | [Rule reference](reference/workspace-dependency-declarations.md) | Active |
| Quality gates | [Quality gates](development/quality-gates.md) | Active |
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
