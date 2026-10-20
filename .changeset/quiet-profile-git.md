---
"@agent-teams/engineering-foundation": patch
---

Keep changed-file Git inspection read-only by using an owned index snapshot that preserves racy-edit detection. Repository tooling separates source Git authority from ordinary child commands and keeps changed-file checks with the source checkout.
