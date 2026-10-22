---
"stack-toolchain": minor
---

Report actual installed versions and availability for all six pinned tools through
`doctor --json`, with stable findings for missing required tools and pin mismatches.
Keep optional engine absence informational and resolve executable files within the
consumer installation, including pnpm and Bun stores.
