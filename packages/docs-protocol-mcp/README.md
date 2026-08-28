# `@agent-teams/docs-protocol-mcp`

Open-source optional read-only MCP stdio adapter for documentation governed by
`@agent-teams/docs-protocol` in any repository.

```sh
docs-protocol-mcp --consumer-root /absolute/repository/path
```

The consumer root is fixed when the process starts. The profile is selected by
an optional `--profile` argument or deterministic discovery of
`docs.config.yaml` and the legacy
`architecture/foundation/docs-protocol.yaml` path. Discovery fails closed when
both or neither exist. MCP tool arguments cannot replace either value.

The read-only adapter is qualified on POSIX and Windows. A Windows repository
must already contain portable authority initialized and committed from a
supported POSIX host; the adapter never performs bootstrap mutation or
recovery.

The V1 surface contains only `docs_info`, `docs_find`, and `docs_context`.
`docs_context` returns bounded `llms.txt` context with optional filters and
advisory fuzzy ranking. There is no authoring, recovery, upgrade, network,
shell, or process-execution capability.

Results are bounded, request cancellation is propagated through an
`AbortSignal`, and unexpected failures are returned without host paths or raw
error details.

Successful tool calls use the closed Agent Teams MCP projection schema version
`1`, return the same projection as text and `structuredContent`, and advertise
their exported `DOCS_*_OUTPUT_SCHEMA_V1` schema through MCP `outputSchema`.
Projection list caps and truncation evidence are part of those schemas. MCP
Server 2.0 supports one success `outputSchema` per tool; `isError` responses do
not carry `structuredContent`, so their separately exported closed
`DOCS_ERROR_OUTPUT_SCHEMA_V1` cannot be registered as an alternate output.
