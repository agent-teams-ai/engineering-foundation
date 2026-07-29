# @agent-teams/engineering-foundation

Development-only engineering foundation for Agent Teams repositories.

The package exposes a typed consumer configuration and explicit local versus
registry lifecycle tooling. It is not a production runtime dependency.

Consumer CI should run both policy gates:

```bash
agent-teams-foundation assert-dev-only
agent-teams-foundation assert-registry
```

Local attach accepts only a built target whose versioned local-mode protocol,
exports, runtime dependencies, and real CLI self-check agree with its package
metadata.

```ts
import { defineFoundationConfig } from "@agent-teams/engineering-foundation";

export default defineFoundationConfig({
  schemaVersion: 1,
  projectId: "agent-teams-orchestrator",
  projectKind: "service",
  capabilities: {
    architecture: { enabled: true, configPath: "architecture/package-catalog.yaml" },
    documentation: { enabled: true, configPath: "docs/metadata.schema.json" },
    lint: { enabled: true }
  }
});
```
