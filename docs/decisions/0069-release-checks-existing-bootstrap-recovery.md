---
id: ADR-0069
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0069: Release Checks Existing Bootstrap Recovery

Status: Accepted bounded successor; implementation qualification, full CI and
protected execution pending. Decision owner: Product owner. Date: 2026-10-24.
The repository coordinator recorded acceptance under the authorized delivery after
independent plan/document review of draft SHA-256
`bebc4bfa180b95b2bd7ed0dae8913601193396f7a2ed279ea0a614fe993f691f`
(verdict GO, retained `release-checks-recovery-classification-40079845789.md`).

## Evidence and scope

[Run 40079845789, attempt 1](https://github.com/agent-teams-ai/engineering-foundation/actions/runs/40079845789/attempts/1)
published `@agent-teams/release-checks@0.0.0` from
`dae3f6565698a0f9a1dff71c2aa8c3ff2e674a73`; its bounded install/audit failed
with E404 during npm processing. The later unchanged signature audit has empty
invalid/missing sets and verified signed SLSA bound to that exact source and
invocation. Retained `readonly-release-checks-signature-audit.json` SHA-256:
`8938fe9845adb80893cf595e51ba1dd8b866e890c24940556fd281bc5c6408a5`.
The original archive SHA-256 is
`d26d094111315e41fb8175f6389689fcee9da21b0d7a1857d584731af7059d32`.
This is publication evidence, not completed bootstrap: deprecation and GitHub
reconciliation remain pending. Temporary credentials and activation were removed.

## Decision

Extend only ADR-0068's exclusion of the Stack-only recovery and ADR-0066's
closed package scope to this exact original publication. Keep all accepted ADR
bytes unchanged; whole-document supersession stays empty. The closed catalog
retains approved tree `d9d922a360ba81eebcbecb50fa4baeddf9faa9bf` and archive SRI
`sha512-N3Sfwq4C8TUdSHMJfzB1TjTOPo3I6/xlcPzSJJuHAKQKpFJ0z3XK4ywfwjV7duEjEkAKGKTaqKLgoCYRcEJ35g==`.
It adds only the original source/run/attempt above and provider placeholder SRI
`sha512-s3oGJ5nLk0UOUwAK72jDhUz83sdPdLwQUboUt+LrIcIOCQSsBCGM70sdI5CvOsiBy4KDtszFEvu7tw/f9Ioujg==`.
The parser admits the exact Release Checks id/name/source/run/attempt/placeholder
tuple alongside unchanged Stack admission, never arbitrary recovery profiles.

The existing Foundation release-policy owner and shared qualified-history
classifier already cover bootstrap and ordinary release. Reuse them and the
existing-artifact-only verifier; no package, module boundary or public API is
added. A separate shared package would duplicate this private release authority.
The 374-byte placeholder expands to 2,560 bytes: apply ADR-0066's unchanged
bounded, exact-record/two-file archive qualification before filtering history.
Its spelling, `stub` flag or registry metadata alone cannot grant admission.

Require the original signed invocation URL and original source, subject and SRI;
current protected-main checkout, fresh main CI, fences, token window and
environment review separately authorize execution. Catalog-derived existing-only
mode must never pack, publish or fall back when real `0.0.0` is absent, including
stage-only history. Preserve all availability/audit bounds and exact guarded
deprecation/postconditions. Reconcile the scoped Git tag and prerelease to the
original source; keep current main as GitHub write authority. Unknown versions,
placeholder-targeting tags, changed bytes or unverifiable provenance reject.
Never delete versions, move npm tags or use quarantine as successful recovery.
After each terminal attempt revoke the token, remove the secret and disable
activation. Trusted Publisher setup and ordinary supported `0.1.0` publication
remain separate, with their existing qualification.

## Qualification

Reject foreign identities, changed source/run/attempt, placeholder bytes/records,
wrong signed invocation, current/original confusion and absent real artifacts.
Retain unchanged Stack tests. Independent exact-head review and full native CI
precede protected execution; this record grants no claim that recovery ran.
