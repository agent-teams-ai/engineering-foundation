---
"@agent-teams/docs-protocol": patch
---

Add expectedPlanDigest and --expect to docs new, matching the existing docs init contract: apply with a mismatched --expect returns authority-stale without mutating, and direct apply without --expect remains backward-compatible.
