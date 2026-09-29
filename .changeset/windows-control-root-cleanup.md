---
"@agent-teams/engineering-foundation": patch
---

Retry transient Windows control-root removal failures within a fixed bound while
preserving the existing behavior for persistent failures.
