---
"@agent-teams/engineering-foundation": minor
---

Consolidate `architecture.source-dependencies` into its single `schemaVersion: 1`
contract while preserving mandatory entrypoints, ambiguous-boundary rejection,
cross-boundary import fencing, and runtime and type-only cycle checks.

Consumers using the short-lived `0.6.0` source-dependency schema must change
`schemaVersion: 2` to `schemaVersion: 1`; their entrypoints and policy remain the
same.
