---
"@agent-teams/repository-mutation": minor
---

Restore the historical known-file Plan and Receipt schemas to their exact
Foundation 0.21.0 bytes. Current callers must select the new
`schemas/repository-mutation/known-file-transaction-{plan,receipt}/v1.schema.json`
exports. Current wire version 1, protocol, digests, envelope version 6, and exact
owner and kernel recovery bindings remain unchanged. Historical journals require
their retained exact Foundation artifact or manual recovery; no bridge is added.

This slice requires the coordinated Authoring, Foundation, and Managed schema
reference closure before publication.
