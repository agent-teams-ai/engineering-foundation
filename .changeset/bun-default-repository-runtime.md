---
"@agent-teams/engineering-foundation": minor
---

Add the Bun default repository runtime profile, closed Bun package-script
adapter, deterministic workspace projection and explicit clean Node/pnpm
rollback while preserving supported public Node 24/26 and Node-owned test,
coverage, package-manager and release lanes.

Publish repository-agent-workflow policy schema v2 with an explicit Bun or pnpm
manager. Version 1 remains pnpm-only. The repository adopts v2; its clean Node
projection records and verifies the corresponding pnpm policy bytes.
