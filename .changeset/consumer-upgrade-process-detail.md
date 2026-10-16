---
"@agent-teams/docs-protocol-agent-teams": patch
---

Report the tail of both output streams, labelled, when a consumer upgrade process
fails. pnpm writes `ERR_PNPM_*` to stdout and configuration warnings to stderr, so
a consumer with an unset variable in its user npmrc used to see only the warning.
