---
name: docs-authoring
description: Create and maintain repository documentation using the portable Docs Protocol layout.
---

# Documentation authoring

Protocol declaration: agent-teams.docs-protocol/v1.

Read `docs.config.yaml` and the local authority files before changing documentation.
Choose the matching document type and declared owner.

1. Discover existing material with `docs-protocol find --consumer . --profile docs.config.yaml --text QUERY`.
2. Preview creation with `docs-protocol new --consumer . --profile docs.config.yaml --type TYPE --id ID --title "TITLE" --owner OWNER_ID --summary "SUMMARY" --dry-run`.
3. Apply the reviewed intent with `docs-protocol new --consumer . --profile docs.config.yaml --type TYPE --id ID --title "TITLE" --owner OWNER_ID --summary "SUMMARY" --apply`.
4. If the result is `manual-required`, add its exact `markdownLink` to its exact `indexPath` before verification.
5. Refresh bounded context with `docs-protocol context --consumer . --profile docs.config.yaml`.
6. Verify authorities and documents with `docs-protocol check --consumer . --profile docs.config.yaml`.

Create files only and never overwrite an existing document.
Do not assume a package manager, hosting provider, or repository forge.
