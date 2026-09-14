---
"@agent-teams/engineering-foundation": patch
---

Parse Oxlint and ESLint suppression explanations separately from rule IDs so exact waivers match comments with human reasons. Preserve rejection of unregistered, global, unscoped, protected-rule, and legacy suppressions.
