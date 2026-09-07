---
"@agent-teams/document-authoring": minor
---

Correct the generic planning, apply, and recovery TypeScript contracts to describe
the supported v1 and v2 document generations. Generic planning accepts the v2
parent policy, and generic results expose discriminated Plan and Receipt unions.
Callers must narrow `schemaVersion` before accessing generation-specific fields;
`DocumentPlan` and `DocumentReceipt` remain the v1 aliases. The explicit V2
entrypoints retain their documented behavior.

Keep public functions explicitly declared across feature composition so consumers
do not depend on private factory functions or coordination types. Runtime
planning, publication, replay, and exact-artifact recovery behavior is unchanged
by these declaration corrections.
