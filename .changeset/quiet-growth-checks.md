---
"@agent-teams/engineering-foundation": patch
"@agent-teams/feature-module-standard": patch
---

Reuse portable path identities within source-policy validation, and index
portable roots within each coverage and classification operation so file lookups
visit their path ancestors instead of comparing every declared root. Preserve
schema v1 specificity, raw-path validation, ownership, overlap, ambiguity and
diagnostic ordering. Skip the nested assembly-surface scan for top-level FMS
features, where the missing-parent-assembly rule cannot apply; nested checks and
cycle semantics remain unchanged.
