---
"stack-toolchain": patch
---

Allow a separate syntax lint scope before the existing typed lint scope. Keep flat
configurations unchanged, short-circuit syntax failures, and preserve named lane
results under one cancellation signal and deadline.
