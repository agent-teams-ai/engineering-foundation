---
"@agent-teams/repository-mutation": patch
---

Add an exhaustive cross-check test proving all four independent Windows-reserved-name path checks in the repo (repository-mutation, engineering-foundation legacy-scaffolding, engineering-foundation source-dependencies, document-authoring) classify identically across reserved names, extensions, case variants, and near-miss names such as COM10 and CONMAN. No behavior change: this locks in and documents an already-consistent contract per plan section 8 item 4.
