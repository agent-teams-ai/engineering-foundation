---
"@agent-teams/docs-protocol": patch
---

Treat the optional `@types/node` peer context as type-only metadata when validating a pnpm runtime closure. Continue to verify the complete executable dependency graph, exact versions, registry integrity values, and every non-type peer context.
