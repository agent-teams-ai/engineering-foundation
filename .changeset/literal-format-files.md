---
"stack-toolchain": minor
---

Add an opt-in read-only literal-file formatting API with explicit contract
negotiation, bounded execution and partial-result evidence. Preserve the existing
configured native formatter scope and ignore semantics.

Use node-or-bun 0.2.5 for bounded capture allocation and a monotonic EOF grace
period without changing checker selection or fallback behavior.
