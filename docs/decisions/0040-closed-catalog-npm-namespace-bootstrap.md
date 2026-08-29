---
id: ADR-0040
status: superseded
supersedes: []
superseded_by: [ADR-0041]
---

# ADR-0040: Closed-Catalog npm Namespace Bootstrap

Status: Accepted

Date: 2026-08-29

Decision owner: Product owner

## Context

Ordinary releases use npm Trusted Publishing and GitHub OIDC, but npm can only
configure that relationship after a package namespace exists. Docs Protocol MCP
needs one immutable `0.0.0` namespace baseline before Changesets may publish its
first supported version. ADR-0028 and ADR-0029 describe the completed historical
Docs Protocol bootstrap and must remain immutable rather than becoming a copied
second implementation.

A reusable mechanism must preserve the narrow one-time exception without turning
token publication into an alternative release path. It must also prevent a
partially observed or foreign first publication from being resumed or promoted.

## Decision

1. One versioned data-only catalog owns every bootstrap profile. A profile is
   `candidate`, `approved`, or `historical`; only an exact `approved` profile may
   execute. The catalog binds package identity, `0.0.0`, exact runtime
   dependencies, closed tar contents, package Git tree, tarball SRI, tags,
   deprecation text, source workflow, repository, and protected ref.
2. One package-neutral policy kernel and one manual workflow implement bootstrap.
   Package differences remain catalog data. Historical profiles are verification
   authority only and their retired workflows are not restored or rerun.
3. Bootstrap remains separate from the ordinary ordered OIDC publisher. Its only
   credential-bearing step accepts a short-lived granular npm token through a
   protected GitHub environment. The dispatch records the reviewed creation and
   expiry window, rejects a lifetime over 24 hours or less than 15 minutes
   remaining, and requires an environment reviewer to verify package scope and
   lifetime in npm before approval. The operator revokes the token immediately
   after postconditions; no repository or organization secret retains it.
4. Before any npm write, a clean protected-main checkout builds twice through the
   repository gates and binds the exact package tree, pack report path, archive
   bytes, SRI, regular-file-only tar listing, content allowlist, and exact packed
   runtime dependency map to the approved profile.
5. Only a canonical registry 404 after bounded read-only retries means the
   namespace is absent. A 5xx, timeout, malformed response, unexpected version,
   tag, dependency, or SRI is unknown or conflicting and fails closed. Publish is
   attempted at most once. An uncertain result is reconciled only with bounded
   read-only observations.
6. Reuse is allowed only for the isolated exact `0.0.0` artifact with the reviewed
   SRI. Before tags or deprecation are changed, npm's signature audit must verify
   both the publish attestation and SLSA provenance, bound to the exact package,
   SRI, repository, workflow, ref, and reviewed commit.
7. Success requires exact immutable bytes, the `bootstrap` and temporary `latest`
   tags, exact deprecation text, clean npm signature evidence, and source-bound
   provenance. Git tag and prerelease reconciliation occurs in a separate
   token-free job and reuses existing state only when it resolves to the same
   reviewed commit.
8. The ordinary release entrypoint independently proves every required approved
   bootstrap baseline, SRI, deprecation, signature, publish attestation, and SLSA
   source binding before its first registry write. Candidate profiles, absent
   baselines, and even a local package still at `0.0.0` cannot be published by the
   ordinary writer.
9. After the first supported release is proven, the bootstrap profile becomes
   historical, npm Trusted Publisher is configured for the package, the temporary
   token is revoked, and all later versions use only the ordinary OIDC flow.

## Consequences

- Another package namespace can reuse reviewed policy without copying workflow or
  provenance logic, but it still needs an explicit catalog approval and protected
  environment review.
- Bootstrap cannot become a general recovery publisher. Conflicting immutable
  bytes require quarantine and a new reviewed version.
- The brief `latest -> 0.0.0` state is deprecated and non-adoptable. Exact-version
  consumer documentation remains gated on registry resolution of supported
  coordinates.
- Human verification of granular-token scope and lifetime is an explicit boundary
  because npm does not expose those properties as trustworthy workflow input.
  Environment approval and immediate revocation are therefore mandatory evidence,
  not optional ceremony.

## Verification

- catalog/parser and pack-evidence contract tests;
- workflow permissions, secret-boundary, reuse-before-mutation, and repository
  security-baseline tests;
- ordinary release tests proving the writer is never reached without the full
  baseline;
- disposable packed and public-registry consumer E2E for npm and pnpm on qualified
  platforms;
- exact npm packument, SRI, deprecation, signature, provenance, tag, GitHub release,
  Trusted Publisher, and token-revocation evidence.
