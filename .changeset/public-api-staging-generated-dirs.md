---
"@agent-teams/engineering-foundation": patch
---

Exclude the generated runtime-profile projection from public API extraction
staging so a qualified workspace cannot duplicate the source tree or exhaust
the staged repository entry budget during release versioning.
