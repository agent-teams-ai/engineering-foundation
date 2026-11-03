---
"stack-toolchain": minor
---

Add opt-in native cleanup presets and an explicit-file `fix` command and `fixFiles`
API. Reuse the installed process owner and literal input protections while keeping
ordinary checks read-only. Default cleanup performs three bounded syntax fixes
and existing formatting without typed fixers, JavaScript plugins, import sorting,
Git discovery or automatic activation in consumer repositories.
