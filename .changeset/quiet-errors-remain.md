---
"@agent-teams/engineering-foundation": patch
---

Requalify `quality.source-coverage` with Oxlint 1.83.0. Caught errors passed as
an `AggregateError` cause remain preserved, while discarded caught errors still
fail the protected `preserve-caught-error` rule.
