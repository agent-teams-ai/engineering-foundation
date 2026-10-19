---
"@agent-teams/engineering-foundation": minor
"@agent-teams/feature-module-standard": patch
"@agent-teams/docs-protocol-agent-teams": patch
---

Add the Bun default repository runtime profile, closed Bun package-script
adapter, deterministic workspace projection and explicit clean Node/pnpm
rollback while preserving supported public Node 24/26 and Node-owned test,
coverage, package-manager and release lanes.

Publish repository-agent-workflow policy schema v2 with an explicit Bun or pnpm
manager. Version 1 remains pnpm-only. The repository adopts v2; its clean Node
projection records and verifies the corresponding pnpm policy bytes.

Republish Feature Module Standard with the updated Foundation peer range and
exact development dependency produced by its workspace manifest projection.

Publish workspace-dependency-declarations policy schema v2 with an explicit Bun
or pnpm manager and the existing pnpm-workspace.yaml catalog authority. Version 1
remains pnpm-only. The Node projection records and verifies both dependency
policy digests alongside its root manifest and workflow policy evidence.

Observe the pinned pnpm version without triggering installation when the
read-only qualification observer runs from a Bun-managed workspace.
