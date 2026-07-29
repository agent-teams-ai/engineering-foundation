# @agent-teams/engineering-foundation

Development-only engineering foundation for Agent Teams repositories.

The package exposes a typed consumer configuration and explicit local versus
registry lifecycle tooling. It is not a production runtime dependency.

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
