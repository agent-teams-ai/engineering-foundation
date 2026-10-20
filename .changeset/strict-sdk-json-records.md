---
"@agent-teams/docs-protocol-agent-teams": patch
---

Use the existing strict JSON parser for SDK manifest and profile records. Preserve duplicate-key and object-root diagnostics, reject nested decoded-key duplicates consistently, and identify malformed syntax with the input's subject.
