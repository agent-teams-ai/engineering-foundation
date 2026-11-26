---
"@agent-teams/repository-mutation": patch
"@agent-teams/document-authoring": patch
"@agent-teams/docs-protocol": patch
"@agent-teams/docs-protocol-agent-teams": patch
"@agent-teams/docs-protocol-mcp": patch
"@agent-teams/engineering-foundation": patch
"@agent-teams/feature-module-standard": patch
---

Request fresh coordinated package versions after the previous Node 26 managed-upgrade release could not complete verification of npm's publish attestation. This forward publication recovery preserves public APIs and runtime behavior. The ordinary publisher must verify the exact package bytes, registry signatures, and both provenance and publish attestations before the delivery can be accepted.
