---
id: ADR-0063
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0063: Explicit Changed-Check Coverage Policy Schema

Status: Accepted. Decision owner: Product owner. Date: 2026-10-20.

## Context

The agent workflow coverage delivery extends the repository agent workflow
policy with an explicit changed-check coverage shape. `scopes`, `checks`,
`exclusions` and `escalationCheck` declare which required facets each scope
covers and which closed check set supplies them, while the existing
`changedChecks` and `fullScanPaths` shape remains valid unchanged. The
published `schemas/repository-agent-workflow/v2.schema.json` bytes therefore
change: the title records the coverage extension, the top-level `required`
becomes an `anyOf` union of the legacy shape and the explicit coverage shape,
the new coverage definitions are added, and the `repositoryPath` pattern is
tightened to the exact runtime `CONFIG_PATH_INVALID` predicate (no leading
separators, backslashes, empty segments, dot segments or trailing separators).

Under the released public API admission procedure every changed member of a
released export is conservatively breaking. The artifact comparison binds
exactly one changed member for `@agent-teams/engineering-foundation`:
`member:schemas/repository-agent-workflow/v2.schema.json` under `./schemas/*`.
Every typed entrypoint surface of every governed package is unchanged, and no
other data member changed.

## Decision

Accept this schema evolution and approve exactly one breaking fingerprint for
`@agent-teams/engineering-foundation`:

```yaml
# @agent-teams/engineering-foundation
- fingerprint: sha256:bf6fd082d951c6857f0de414d4472cfbeae3b7357004c3d3911d9820b3b516e6
  decisionId: ADR-0063
```

This fingerprint is the complete export-path-aware change set of that single
member and authorizes nothing else. No other member, package, removal, or
additive export inherits this approval; a different edit to the same schema
file changes the fingerprint and fails closed until separately approved.

`@agent-teams/engineering-foundation` is past `1.0.0`, so the required and
declared release bump is major. The delivery Changeset declares major for that
package.

Both policy shapes stay admitted exactly as before through the union branch
that reproduces the previous `required` set. The tightened `repositoryPath`
pattern only rejects strings the runtime path check already rejected with
`CONFIG_PATH_INVALID`, so no policy configuration that ever ran loses
validity; the published schema now agrees with the validator it documents
instead of accepting paths the runtime refuses.

The alternative of a new versioned schema file was rejected: `schemaVersion`
selects the policy contract, not a file revision, and the coverage extension
keeps the `v2` contract with both shapes valid under one identity. The
release-owned baseline promotion and the accepted-decision baseline are
unaffected beyond this single approved record.
