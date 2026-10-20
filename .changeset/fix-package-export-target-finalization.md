---
"@agent-teams/engineering-foundation": patch
---

Keep literal wildcard characters in exact package export targets and validate
the original target before pattern substitution. Invalid selected URL paths and
structural wildcard captures now reject without trying a later array fallback;
invalid original package targets retain Node's array fallback behavior. Query
and fragment annotations follow Node's import/require finalization rules. Export
selection remains bounded and independent of file existence.
