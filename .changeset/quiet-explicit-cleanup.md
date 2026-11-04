---
"stack-toolchain": minor
---

Add opt-in native cleanup presets and an explicit-file `fix` command and `fixFiles`
API. Reuse the installed process owner and literal input protections while keeping
ordinary checks read-only. Default cleanup performs two bounded syntax fixes
and existing formatting without typed fixers, JavaScript plugins, import sorting,
Git discovery or automatic activation in consumer repositories.

Keep `prefer-const` diagnostic-only by default: direct eval can write local and
loop bindings that native binding analysis does not see.
