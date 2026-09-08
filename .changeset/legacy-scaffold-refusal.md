---
"@agent-teams/engineering-foundation": patch
---

Preserve recognized 0.9.0 legacy scaffold evidence by refusing mismatching readers
before Foundation lock acquisition. Report incompatible regular locks as manual
recovery without an executable route; retain existing barriers and under-lock
admission checks. Refs #260 and #271.
