---
"@agent-teams/engineering-foundation": minor
---

Add deterministic source graph v2, documentation and ADR governance, Protobuf
and JSON Schema release checks, property-test replay helpers, and hardened
workflow security qualification.

This pre-1.0 minor also hardens existing public API compatibility policies.
Schema v1 consumers must move any custom released baseline to
`architecture/public-api/<package-local-name>.json`. Breaking-change approvals
must resolve through the immutable accepted-ADR baseline; raw ADR Markdown is no
longer sufficient evidence. Follow the migration procedure in
`docs/architecture/public-api-compatibility.md` before upgrading an affected
consumer.
