---
"@agent-teams/engineering-foundation": major
"@agent-teams/feature-module-standard": minor
---

Replace quality source-coverage profiles v1–v4 with v5's architecture-neutral
topology and one captured invocation. Execution no longer rereads a profile to
select different lint/project inputs; bounded consumer-file verification rejects
persistent changes before success and preserves the admitted report version.

Move FMS topology projection to the opt-in package's pure `./quality-topology`
export, preserve historical schema artifacts and provide the v5 migration guide.
Existing consumers may retain their previous pinned major until they migrate.
