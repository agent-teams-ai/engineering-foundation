---
"@agent-teams/engineering-foundation": patch
---

Serialize findings-baseline pruning through the repository mutation lease and
reuse owned atomic replacement. Concurrent supported writers can no longer
overwrite a completed prune with stale counts, and cleanup preserves foreign
temporary files. Preserve failure evidence and report an uncertain result if
replacement completes but resource finalization fails.
