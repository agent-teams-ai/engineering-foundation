---
"@agent-teams/engineering-foundation": patch
---

Harden Windows process containment confirmation and emit bounded cleanup
diagnostics without exposing child-process output. Compile the native helper
from trusted source text so deep installed package paths never enter CodeDom.
