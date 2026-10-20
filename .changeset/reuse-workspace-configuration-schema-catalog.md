---
"@agent-teams/engineering-foundation": patch
---

Validate workspace dependency configuration through the existing shared schema
catalog, scoped to the capability's composition. Filesystem loaders receive a
narrow assertion dependency and map only validated v1/v2 input. Preserve schema
diagnostics, format annotations, manager dispatch and immutable settings while
removing the duplicate Ajv constructor and validation-message formatter.
