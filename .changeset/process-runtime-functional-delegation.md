---
"@agent-teams/engineering-foundation": patch
---

Delegate managed process execution to the accepted process runtime while
preserving Foundation result facts, error translation, POSIX process-group
containment and Windows Job Object cleanup. Retain a bounded Windows diagnostic
suffix and require the profile-composed explicit Node executable for the Windows
bootstrap when Bun executes Foundation. This does not change the repository's
current default runtime.
