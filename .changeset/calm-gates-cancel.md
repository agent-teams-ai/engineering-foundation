---
"@agent-teams/engineering-foundation": patch
---

Emit one canonical JSON error envelope when SIGINT or SIGTERM cancels quality-gate
configuration or catalog loading, with exit codes 130 and 143 respectively.
Retain an already observed successful task as passed with exit code 0 while the
aggregate run is cancelled, and keep task or containment failures authoritative
over cancellation.
