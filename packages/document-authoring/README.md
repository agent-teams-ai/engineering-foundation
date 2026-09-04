# Document Authoring

`@agent-teams/document-authoring` owns the portable deterministic authoring
protocol: inert profiles, canonical catalog observation, Intent and Plan
compilation, create-only materialization, journals, receipts, and exact-build
recovery. It depends only on `@agent-teams/repository-mutation` inside this
monorepo.

Repository Markdown and YAML remain canonical. Consumer-specific document
types, schemas, owners, templates, placement, reachability, and semantic policy
remain consumer-owned inert data.

Published packages bundle the private Markdown parser adapter. The maintained
upstream components remain embedded, not eliminated; their security advisories
still apply. `dist/markdown-upstream.cdx.json` lists those components in CycloneDX
format, `dist/markdown-upstream-notices.txt` retains their licenses, and
`dist/markdown-distribution-proof.json` binds the build to original lockfile
archives. Public authoring types and the first-party dependency boundary stay
unchanged.
