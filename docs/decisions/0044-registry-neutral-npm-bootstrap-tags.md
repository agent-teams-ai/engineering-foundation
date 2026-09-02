---
id: ADR-0044
status: accepted
supersedes: [ADR-0042]
superseded_by: []
---

# ADR-0044: Registry-Neutral npm Bootstrap Tags

Status: Accepted

Date: 2026-09-02

Decision owner: Product owner

## Context

ADR-0042 recorded that the public npm registry added both `bootstrap` and
`latest` during an earlier first publication even though the workflow requested
only `bootstrap`. A later first-publication path can instead expose only the
requested tag. Treating either observation as universal makes the generic
bootstrap workflow fail after npm has accepted immutable bytes, or tempts it to
promote an unsupported `0.0.0` artifact explicitly.

The tag shape is mutable registry metadata and is not package provenance. The
workflow needs one bounded policy for both registry-created outcomes without
normalizing between them.

## Decision

1. Bootstrap publishes once with `--tag bootstrap` and never creates, removes,
   or moves a dist-tag explicitly.
2. Every bootstrap state requires `bootstrap -> 0.0.0`. The registry may also
   have created `latest -> 0.0.0`; no other tag or target is allowed.
3. The closed catalog represents tag policy as required and allowed sets. Its
   schema v2 requires `bootstrap` and allows only `bootstrap` and `latest`.
4. Preflight, reuse, normal completion, and quarantine accept both exact allowed
   shapes. They reject a missing or wrong `bootstrap`, a wrong `latest`, a
   foreign tag, an extra version, SRI drift, or provenance drift.
5. Normal completion still requires signature, publish attestation,
   source-bound provenance, reviewed SRI, and exact deprecation before GitHub
   reconciliation. Quarantine accepts either tag shape but cannot authorize a
   release baseline or GitHub reconciliation without provenance.
6. Only the ordinary protected-main Trusted Publisher may establish or move
   `latest` to a supported release.

## Consequences

- A bootstrap-only registry result remains non-default and is never promoted by
  recovery logic.
- A registry-created first-version `latest` is represented honestly and bounded
  to the reviewed bytes.
- Retries are idempotent across both observed registry behaviors without
  weakening immutable artifact or provenance checks.

## Verification

- catalog parser tests for required and allowed tags;
- state-machine tests for both valid shapes and every conflicting tag shape;
- workflow tests proving no `npm dist-tag` command exists;
- ordinary release tests proving only the supported publisher owns `latest`.
