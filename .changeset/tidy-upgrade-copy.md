---
"@agent-teams/docs-protocol-agent-teams": patch
---

Use isolated copy imports for consumer upgrades so pnpm store hardlinks do not fail installed CLI safety checks. Preserve the prior installation on an install failure and retain both errors and backup evidence if restoration fails.
