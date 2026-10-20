---
"@agent-teams/engineering-foundation": major
---

Add `agent-workflow check-changed` with explicit v2 coverage policy and reports, preserving the existing `changed` command and v1 schema contract. Breaking: `schemas/repository-agent-workflow/v2.schema.json` changes its published bytes (the policy schema now admits both the legacy `changedChecks`/`fullScanPaths` shape and the explicit `scopes`/`checks`/`exclusions`/`escalationCheck` coverage shape, and its `repositoryPath` pattern now matches the runtime path validator); the exact change fingerprint is approved under ADR-0063. No typed export changes. Limitation: the current mutable Host returns feedback-only results with unverified input binding and no qualified coverage facets, so `check-changed` observes and reports coverage but does not gate it yet.
