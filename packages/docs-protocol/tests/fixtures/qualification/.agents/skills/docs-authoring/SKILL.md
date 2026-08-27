# Docs authoring

Use agent-teams.docs-protocol/v1 through the repository scripts.

1. Read the repository documentation profile before writing.
2. Keep document IDs, owners, and statuses within that profile.
3. Search before creating a document.
4. Run `pnpm docs:find -- <query>`.
5. Reuse or relate existing documents when appropriate.
6. Choose the declared document type and owner.
7. Supply the required metadata and relations.
8. Preview the exact planned change.
9. Run `pnpm docs:new -- --dry-run <arguments>`.
10. Review the destination, metadata, and diagnostics.
11. Resolve required blockers and code-anchor errors.
12. Apply the reviewed plan.
13. Run `pnpm docs:new -- --apply <arguments>`.
14. Do not hand-edit generated metadata or transaction evidence.
15. If the result reports a manual index link, add that link to the reported index.
16. Preserve the exact link text and repository-relative destination.
17. Validate the resulting documentation corpus.
18. Run `pnpm docs:protocol:check`.
19. Use `pnpm docs:doctor` when authority or recovery is unclear.
20. Use `pnpm docs:recover` only for the reported pending transaction.
