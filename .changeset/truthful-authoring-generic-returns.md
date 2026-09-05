---
"@agent-teams/document-authoring": minor
---

Correct the pre-first-supported Authoring generic planner, apply, and recovery
declarations to return the existing v1/v2 Plan and Receipt unions. Generic
planning accepts the existing optional parentPolicy contract. Callers must narrow
schemaVersion or protocolVersion before using generation-specific fields;
DocumentPlan and DocumentReceipt remain v1 aliases, and explicit V2 APIs remain.
This is a TypeScript source change, not a claim of source compatibility with the
historical 0.0.0 namespace bootstrap. Runtime behavior, wire schemas, and
exact-owner/build recovery support remain unchanged.
