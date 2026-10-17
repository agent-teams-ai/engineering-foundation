---
"@agent-teams/engineering-foundation": minor
---

Preserve reference kinds and unresolved computed loaders in the public source
graph. Observe direct ESM runtime export names and kinds through the existing
Oxc parser, with per-file coverage and explicit unsupported forms instead of
fabricated complete counts. Keep unresolved, external and parse-failure lanes.

Consumers retain ownership of syntax restrictions and CMS/FMS profile mappings.
This additive source API changes no dependency-policy schema, architecture
standard, consumer pin or release admission.
