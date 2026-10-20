---
"@agent-teams/engineering-foundation": patch
---

Correct source-dependency and source-graph classification of ordinary imports
and export-from declarations containing only inline `type` specifiers. Their
module request survives Node type stripping and TypeScript verbatim emit, so
they now retain runtime mode. Runtime boundaries reject these references to
development-only dependencies, and source-graph consumers see their load-cycle
edges. Declaration-level `import type` and `export type` remain type-only.
