---
"@agent-teams/document-authoring": minor
"@agent-teams/engineering-foundation": major
"@agent-teams/docs-protocol": minor
"@agent-teams/docs-protocol-agent-teams": patch
---

Extract portable document authoring into its own package, remove the obsolete
Engineering Foundation authoring exports and CLI, and rewire Docs Protocol to
the new-only dependency graph without a compatibility facade.
