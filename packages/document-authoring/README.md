# Document Authoring

`@agent-teams/document-authoring` owns the portable deterministic authoring
protocol: inert profiles, canonical catalog observation, Intent and Plan
compilation, create-only materialization, journals, receipts, and exact-build
recovery. It depends only on `@agent-teams/repository-mutation` inside this
monorepo.

Repository Markdown and YAML remain canonical. Consumer-specific document
types, schemas, owners, templates, placement, reachability, and semantic policy
remain consumer-owned inert data.
