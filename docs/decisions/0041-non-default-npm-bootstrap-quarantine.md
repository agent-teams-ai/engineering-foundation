---
id: ADR-0041
status: superseded
supersedes: [ADR-0040]
superseded_by: [ADR-0042]
---

# ADR-0041: Non-Default npm Bootstrap Quarantine

Status: Accepted

Date: 2026-08-29

Decision owner: Product owner

## Context

ADR-0040 introduced the closed-catalog namespace bootstrap, but its temporary
`latest -> 0.0.0` postcondition leaves an avoidable adoption path if npm accepts
the tarball and the workflow loses the publish result before it can prove
provenance or apply deprecation. A deprecated artifact is still resolvable by a
default install, and an uncertain artifact must fail safe before provenance is
trusted.

## Decision

1. ADR-0040 items 1-6 and 8-9 remain in force and are incorporated here without
   copying their policy or implementation.
2. Bootstrap publication uses `--tag bootstrap` and may write only the
   `bootstrap` dist-tag. It never creates, moves, or requires `latest`.
3. Success requires the sole exact `bootstrap -> 0.0.0` tag, reviewed immutable
   bytes, exact deprecation text, clean npm signature evidence, and source-bound
   publish and SLSA attestations.
4. An uncertain publish result is observed read-only. If exact SRI or provenance
   cannot be proved, no reuse or token-bearing mutation is authorized. The
   artifact remains non-default behind `bootstrap`; the operator retains
   evidence, revokes the token, disables the workflow, and resolves the incident
   through a newly reviewed version.
5. The ordinary release gate continues to prove the full baseline even while the
   local manifest remains `0.0.0`. A supported release may establish `latest`
   only through the ordinary protected-main OIDC publisher.

## Consequences

- Default package installation cannot adopt a bootstrap artifact, including
  during a partial or uncertain workflow result.
- Another profile remains catalog-only; the workflow does not duplicate package
  identifiers or tag lists.
- Quarantine is fail-safe and non-mutating. Conflicting or unverifiable immutable
  evidence requires a new reviewed version, never promotion or unpublish.

## Verification

- workflow tests prove a string package ID validated by the closed catalog, one
  `bootstrap` publish tag, and no `latest` mutation;
- state-machine tests prove bounded repeated 404 evidence, reuse-time tag-race
  rejection before token-bearing mutation, and full ordinary-release baseline
  proof for a local `0.0.0` manifest;
- the release runbook records token revocation, evidence retention, workflow
  disablement, and new-version recovery for an uncertain artifact.
