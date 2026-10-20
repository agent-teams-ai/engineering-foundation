---
"@agent-teams/engineering-foundation": patch
"@agent-teams/feature-module-standard": patch
---

Reuse portable path identities within each source-policy validation, coverage and
classification operation instead of normalizing the same operands for every
comparison. Preserve raw-path validation, ownership, overlap, ambiguity and
diagnostic ordering. Skip the nested assembly-surface scan for top-level FMS
features, where the missing-parent-assembly rule cannot apply; nested checks and
cycle semantics remain unchanged.
