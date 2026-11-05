---
"@agent-teams/engineering-foundation": patch
---

Preserve foreign installed entries, substituted local-state markers, and unowned
temporary files during local-mode recovery. Require operation-scoped physical
custody before marker replacement or cleanup, retain both operation and
finalization failures, and keep the existing local-mode protocol and public ports.
An orphan backup with an unproven or local installed entry now requires manual
reconciliation; an absent destination remains automatically recoverable, and
independently proven registry state still completes without deleting that entry.

Parse command arguments once for both admission and failure output. Respect `--`
when interpreting JSON output intent and move buffered command preparation and
execution behind their existing application boundary. Preserve delegated command
owners, cancellation lifetimes, lazy error observation, and public CLI envelopes.
