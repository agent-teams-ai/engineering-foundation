---
"@agent-teams/engineering-foundation": patch
---

Inspect governed source inside nested coverage and dist directories and explicitly selected generated-name roots while preserving ordinary package-root generated outputs and explicit source-dependency scope.

Include explicit boundary source roots beneath broader governed roots when traversing coverage and dist routes, including source-file roots and diagnostic fallback discovery. Keep generated siblings excluded and retain v1 governed-only and v2 selected-package coverage.
