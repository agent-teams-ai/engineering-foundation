# `@agent-teams/docs-protocol-agent-teams`

Agent Teams managed integration for the portable
`@agent-teams/docs-protocol` package.

This package exclusively owns Cohort authority, managed consumer state,
transition projectors, managed workflows, managed cohort qualification, and historical
managed assets. It depends on the portable package through that package's public
Node contracts; the portable package never discovers or imports this adapter.

Managed operations use the distinct executable:

```text
agent-teams-docs-managed check --consumer .
agent-teams-docs-managed plan --consumer . --to COHORT
agent-teams-docs-managed apply --consumer . --expect sha256:DIGEST
agent-teams-docs-managed upgrade --consumer . --to COHORT
agent-teams-docs-managed recover --consumer .
agent-teams-docs-managed qualify --consumer .
```

The portable `agent-teams-docs` and `docs-protocol` executables contain only
generic documentation commands. There is no legacy `agent-teams-docs consumer`
route or runtime compatibility bridge.
