---
"@agent-teams/ci-input-proof": patch
"@agent-teams/repository-mutation": patch
"@agent-teams/document-authoring": patch
"@agent-teams/docs-protocol": patch
"@agent-teams/docs-protocol-agent-teams": patch
"@agent-teams/docs-protocol-mcp": patch
---

Publish new patch versions for the canonical packed manifest serialization.
The repository-owned packing hook changes manifest key order, so these archives
need new versions to preserve exact integrity checks for immutable releases.
