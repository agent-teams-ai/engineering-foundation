---
name: docs-authoring
description: Use when creating, changing, reorganizing, or reviewing governed documentation in this repository.
---

# Documentation Authoring

Protocol: `agent-teams.docs-protocol/v1`.

## Required workflow

- Read the current types, owners, placement, metadata, and index policy with `pnpm docs:info`.
- Search first (docs-protocol find) with `pnpm docs:find -- --text query`.
- Reuse or relate existing authority instead of creating a competing source.
- Preview (docs-protocol new) with `pnpm docs:new -- --type TYPE --id ID --title TITLE --owner OWNER --summary SUMMARY --dry-run`.
- Review the exact destination, metadata, relations, anchors, and diagnostics.
- Apply (docs-protocol new) with `pnpm docs:new -- --type TYPE --id ID --title TITLE --owner OWNER --summary SUMMARY --apply` after review.
- If reachability is `manual-required`, update the reported index/link by adding the exact `markdownLink` to the reported `indexPath`.
- Refresh bounded context with `pnpm exec docs-protocol context --consumer "CONSUMER" --profile "PROFILE" --max-documents 8 --max-bytes 32768`; copy CONSUMER and PROFILE from the existing `docs:info` script, never guess a default profile.
- For edits, preserve canonical frontmatter and sidecar ownership; use the repository's governed review flow rather than bypassing the create-only writer.
- For accepted authority, record supersession explicitly instead of silently rewriting history.
- Run `pnpm docs:check` (docs-protocol check), then the full consumer gate `pnpm docs:protocol:check` after the index is current.

## Rules

- Never invent owners, types, statuses, paths, or metadata outside `docs:info`.
- If dependencies are absent, use only `pnpm install --frozen-lockfile`; never use npx, dlx, or latest tags.
- Keep preview and apply inputs identical.
- Stop when recovery is required; use `pnpm docs:doctor` before `pnpm docs:recover`.
- Resolve required anchors and blockers before apply.
- Use repository scripts except the explicit installed read-only context command above; never hand-edit transaction evidence.
