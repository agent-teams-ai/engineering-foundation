# Engineering Foundation Documentation

This directory separates decisions, target architecture, development procedures,
and release operations. Navigation files point to canonical documents; they do
not repeat their rules.

## Canonical documents

| Subject | Document | State |
| --- | --- | --- |
| Foundation ownership | [Ownership boundary](architecture/ownership.md) | Active |
| Executable capability model | [Executable capabilities](architecture/executable-capabilities.md) | Accepted target; implementation pending |
| Consistency evidence gate | [Consistency evidence gate](architecture/consistency-evidence-gate.md) | Accepted target; implementation pending |
| Local package development | [Local mode](development/local-mode.md) | Active |
| Package release | [Release](release.md) | Active |
| Architecture decisions | [Decision index](decisions/README.md) | Active |

## Document roles

- `decisions/` records why a consequential choice was made and what it
  supersedes. Accepted decisions are immutable; a later decision supersedes
  rather than silently rewriting them.
- `architecture/` owns the current target design and engineering invariants.
- `development/` owns contributor workflows that are true today.
- reference schemas and generated material will be added only when executable
  capabilities exist. Generated output is never a source of truth.

Every target document must state whether it is implemented. A target design must
not be presented as an available command or package API before conformance proves
it.
