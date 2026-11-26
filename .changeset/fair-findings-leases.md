---
"@agent-teams/engineering-foundation": patch
"@agent-teams/feature-module-standard": patch
---

Serialize findings-baseline pruning through the repository mutation lease and
reuse owned atomic replacement. Concurrent supported writers can no longer
overwrite a completed prune with stale counts, and cleanup preserves foreign
temporary files. Preserve failure evidence and report an uncertain result if
replacement completes but resource finalization fails.

Refresh the FMS package version because its canonical packed manifest retains
the exact Foundation development dependency, whose bytes change with this patch.
