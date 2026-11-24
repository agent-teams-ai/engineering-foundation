---
"stack-toolchain": patch
---

Pin the parser's visitor-keys dependency to the qualified 8.73.0 scope cohort so
fresh npm and pnpm consumers preserve the same syntax graph without overrides.
