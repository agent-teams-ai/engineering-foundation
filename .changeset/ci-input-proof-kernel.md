---
"@agent-teams/ci-input-proof": minor
---

Add a development-only pure leaf-inventory comparator with strict inert-input
validation, explicit digest schemes and immutable structural/content results.
Completeness, classification, execution and merge authority remain consumer-owned.

Breaking type migration: `InputLeaf` now pairs `type` and `mode` in a discriminated
union. Construct file leaves with `100644`/`100755`, symlinks with `120000`, and
gitlinks with `160000`; narrow dynamic types before assigning modes. Runtime
unknown-input validation is unchanged. See the package README migration note.
