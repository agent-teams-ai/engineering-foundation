# Docs authoring

Use agent-teams.docs-protocol/v1 through the portable CLI.

1. Read the repository documentation profile before writing.
2. Keep document IDs, owners, and statuses within that profile.
3. Search before creating a document.
4. Run `docs-protocol find --consumer . --profile docs.config.yaml --text QUERY`.
5. Reuse or relate existing documents when appropriate.
6. Choose the declared document type and owner.
7. Supply the required metadata and relations.
8. Preview the exact planned change.
9. Run `docs-protocol new --consumer . --profile docs.config.yaml --type TYPE --id ID --title "TITLE" --owner OWNER --summary "SUMMARY" --dry-run`.
10. Review the destination, metadata, and diagnostics.
11. Resolve required blockers and code-anchor errors.
12. Apply the reviewed plan.
13. Run `docs-protocol new --consumer . --profile docs.config.yaml --type TYPE --id ID --title "TITLE" --owner OWNER --summary "SUMMARY" --apply`.
14. Do not hand-edit generated metadata or transaction evidence.
15. If the result is `manual-required`, add its exact `markdownLink` to its exact `indexPath`.
16. Preserve the exact link text and repository-relative destination.
17. Refresh bounded context with `docs-protocol context --consumer . --profile docs.config.yaml`.
18. Run `docs-protocol check --consumer . --profile docs.config.yaml`.
19. Use `pnpm docs:doctor` when authority or recovery is unclear.
20. Use `pnpm docs:recover` only for the reported pending transaction.
