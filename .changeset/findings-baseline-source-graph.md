---
"@agent-teams/engineering-foundation": minor
---

Add the architecture-neutral core mechanisms: a shrink-only findings baseline
(`baseline check`, `init` and `prune` commands for Oxlint findings, and pure
functions on `@agent-teams/engineering-foundation/ratchet`), growth budgets that
only warn, and a public source graph with strongly connected components on
`@agent-teams/engineering-foundation/source-graph`. `quality.source-coverage`
also reads Feature Module Standard v1.1 production mappings; its topology and
every existing diagnostic are unchanged.
