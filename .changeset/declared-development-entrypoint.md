---
"@agent-teams/engineering-foundation": patch
---

Correct SourceDeps v3 admission of explicitly allowed child-package development
imports into exact declared repository development entrypoints. Root package
ownership, both development classifications, boundary permission and the exact
entrypoint must all be proven. Preserve cross-package rejection for missing
facts and retain boundary diagnostics and cycle checks.
