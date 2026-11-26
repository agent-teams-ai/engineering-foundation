---
"stack-toolchain": minor
---

Add the optional `stack-toolchain/effect` API and `effect:check` CLI for explicitly selected strict TypeScript projects. The Linux x64 profile verifies a separately installed pinned native Effect compiler and its standard libraries, requires the declared Effect policy, and preserves ordinary diagnostics without a compiler fallback. Existing Stack commands and dependency installation remain unchanged.
