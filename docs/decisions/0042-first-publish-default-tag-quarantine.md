---
id: ADR-0042
status: accepted
supersedes: [ADR-0041]
superseded_by: []
---

# ADR-0042: First-Publish Default-Tag Quarantine

Status: Accepted

Date: 2026-08-29

Decision owner: Product owner

## Context

ADR-0041 assumed that `npm publish --tag bootstrap` leaves a new namespace
without `latest`. The public npm registry instead assigned both `bootstrap` and
`latest` to the first Docs Protocol `0.0.0` publication. Repository source and
the successful protected run `31901821855` retain this observed evidence: the
workflow added only `bootstrap`, while its exact two-tag postcondition passed.

Removing the sole default tag is not a reliable recovery boundary before a
later version exists. A publish response can also be lost after npm accepts the
immutable tarball but before provenance or deprecation is observed. The workflow
therefore needs an explicit harm-reducing quarantine path without allowing
unverified evidence to become a release baseline.

## Decision

1. ADR-0040 items 1-5 and 8-9 remain in force. Package identity and behavior stay
   in the closed catalog; one package-neutral kernel and workflow own bootstrap.
2. The initial `--tag bootstrap` publication is expected to expose both
   `bootstrap -> 0.0.0` and the registry-created `latest -> 0.0.0`. The workflow
   never creates or moves either tag explicitly.
3. After a normal publish or reuse observation, the workflow re-reads exact
   versions, both tags, SRI, npm signature, publish attestation, and source-bound
   SLSA provenance before its first explicit metadata mutation. Only that proof
   authorizes the exact deprecation message and successful baseline completion.
4. A separate `quarantine` operation may act only on the sole reviewed `0.0.0`
   with exact SRI and both expected tags. It may set the exact deprecation text,
   but cannot publish, create or move tags, reconcile a GitHub release, satisfy
   provenance, or authorize ordinary release.
5. If publish acceptance is uncertain, bounded observation either completes the
   normal proof or fails closed. A hard interruption or permanently missing
   provenance requires the reviewed quarantine operation, retained evidence,
   immediate token revocation, workflow disablement, and an incident record.
6. Ordinary release remains blocked until the approved baseline has valid
   signature and source-bound attestations. If that evidence can never converge,
   recovery requires a successor ADR and newly reviewed bootstrap version/catalog
   schema; the current workflow must not weaken or overwrite `0.0.0`.
7. The first supported ordinary OIDC release replaces `latest` with its supported
   version. Until then, documentation never recommends a floating install and
   exact supported-coordinate availability remains a separate public gate.

## Consequences

- npm's unavoidable first-version default tag is represented truthfully rather
  than hidden behind an untestable no-`latest` claim.
- Quarantine is intentionally asymmetric: deprecation may reduce harm for exact
  reviewed bytes without making unverifiable provenance reusable.
- A permanently unverifiable artifact stops delivery and needs a new reviewed
  version path; this is safer than treating mutable metadata as provenance.

## Verification

- historical protected-run evidence for forced first-version tags;
- policy tests separating exact-SRI quarantine from provenance-bearing reuse;
- workflow tests proving mutation proof precedes normal deprecation, quarantine
  cannot publish or reconcile, and only one step receives the granular token;
- ordinary release tests requiring full evidence even for a local `0.0.0`.
