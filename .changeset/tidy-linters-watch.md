---
"stack-toolchain": minor
---

Upgrade Oxlint to 1.90.0 and its typed companion to 7.0.2005. Preserve existing
rule levels, review the complete 61-rule JavaScript exception and reject unsafe
enum assignments and generated empty object types in TypeScript.

Add explicit experimental Bun lint selection using a separately installed,
exact consumer development alias. Keep Oxlint as the default, preserve selected
scope and bounded process execution, and never fall back after diagnostics.
Preserve configuration/execution errors as exit 2 and caller cancellation as 130.
Document the stable Bun availability gap and the experimental compatibility limits.
