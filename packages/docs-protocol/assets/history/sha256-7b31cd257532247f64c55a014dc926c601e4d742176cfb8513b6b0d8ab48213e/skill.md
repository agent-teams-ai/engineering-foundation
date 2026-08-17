---
name: docs-authoring
description: Use when creating, changing, reorganizing, or reviewing governed documentation in this repository.
---

# Documentation Authoring

Protocol: `agent-teams.docs-protocol/v1`.

## Required workflow

- Read the current types, owners, placement, metadata, and index policy with `pnpm docs:info`.
- Search first with `pnpm docs:find -- --text query`.
- Reuse or relate existing authority instead of creating a competing source.
- Preview with `pnpm docs:new -- --type TYPE --id ID --title TITLE --owner OWNER --summary SUMMARY --dry-run`.
- Review the exact destination, metadata, relations, anchors, and diagnostics.
- Apply with `pnpm docs:new -- --type TYPE --id ID --title TITLE --owner OWNER --summary SUMMARY --apply` after review.
- Manually update the reported index/link exactly when reachability requires it.
- Finish with `pnpm docs:check` after the index is current.

## Rules

- Never invent owners, types, statuses, paths, or metadata outside `docs:info`.
- If dependencies are absent, use only `pnpm install --frozen-lockfile`; never use npx, dlx, or latest tags.
- Keep preview and apply inputs identical.
- Stop when recovery is required; use `pnpm docs:doctor` before `pnpm docs:recover`.
- Resolve required anchors and blockers before apply.
- Do not bypass repository scripts or hand-edit transaction evidence.
