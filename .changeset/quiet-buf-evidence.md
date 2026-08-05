---
"@agent-teams/engineering-foundation": minor
---

Add reproducible pinned Buf `FILE` qualification with versioned evidence binding,
strict normal-check validation, and a real compatibility E2E gate.

This pre-1.0 minor intentionally requires capability configuration v2 and
qualification evidence v2. Existing v1 schemas remain published as immutable
history, but consumers must regenerate qualification evidence through the
protected command before upgrading.
