---
id: ADR-0028
status: accepted
supersedes:
  - ADR-0027
superseded_by: []
---

# ADR-0028: Fail-Closed Docs Protocol Bootstrap

Status: Accepted

Date: 2026-08-14

Decision owner: Product owner

## Context

ADR-0027 correctly separated the first Foundation RC from the first Docs
Protocol registry artifact, but left the one-time hosted publication procedure
implicit. npm trusted publishing cannot authorize an initial publish for a
package name that does not yet exist. The package must first be created with a
bounded credential; only then can its trusted publisher be configured.

An initial publish can partially succeed before tags, deprecation, or provenance
evidence are retained. Retrying must therefore distinguish an absent package
name from the one exact reviewed artifact and reject every other registry state.

## Decision

1. Foundation `0.17.0-rc.0` publishes first through the ordinary protected-main
   release. Until a separate bootstrap promotion is reviewed, Docs Protocol
   remains exactly `0.0.0`, `private: true`, ignored by Changesets, without
   `publishConfig`, and absent from the ordinary publishable-package catalog.
2. The ordinary release workflow and its final publish command independently
   validate that entire bootstrap boundary. Any partial promotion or attempt to
   add Docs Protocol to the ordinary release fails before Changesets can publish.
   If Docs Protocol is public while Changesets prerelease mode is active, normal
   publication additionally requires its exact stable `0.0.0` baseline to
   already exist on npm; plain `changeset publish` can never create it.
3. The repository contains a separate `workflow_dispatch` bootstrap workflow.
   It is dormant unless the repository variable
   `DOCS_PROTOCOL_BOOTSTRAP_ENABLED` is exactly `true`, the dispatch targets
   protected `main`, the operator supplies its exact reviewed commit, and the
   protected `npm-docs-protocol-bootstrap` environment grants approval.
4. A separate reviewed promotion must remove `private` and the Changesets
   ignore, restore exact public npm provenance configuration, retain version
   `0.0.0`, and pack an exact dependency on already published Foundation
   `0.17.0-rc.0`. Until that change lands, the bootstrap workflow fails its
   manifest preflight and cannot publish.
   The promotion carries an official Changesets empty changeset (`---`, `---`,
   then a non-empty summary), recording coverage without scheduling `0.1.0`.
   Release evidence treats only that exact empty frontmatter as release-neutral.
5. Initial publication uses only the environment secret
   `NPM_DOCS_PROTOCOL_BOOTSTRAP_TOKEN`. The operator must create it as a granular
   token restricted to the Docs Protocol package and npm publish permissions,
   with a lifetime no longer than 24 hours. The workflow validates the supplied
   creation/expiry window and refuses a token with less than fifteen minutes
   remaining. The environment secret and token are removed immediately after
   the bootstrap is verified.
6. The workflow builds and qualifies the reviewed commit, materializes the
   canonical license, packs one archive with lifecycle scripts disabled, closes
   its file inventory, verifies the packed public manifest and exact Foundation
   dependency, and computes the archive's SHA-512 integrity. Publication uses
   exactly `npm publish <archive> --tag bootstrap --provenance --ignore-scripts`.
7. Registry preflight requires Foundation `0.17.0-rc.0` and exactly one of two
   Docs Protocol states: the package name is absent, or its only version is
   `0.0.0` with integrity identical to the reviewed archive and no unexpected
   dist-tag. The latter resumes a partial successful attempt without
   republishing. Any other state fails closed.
   Hermetic registry qualification likewise contains Docs Protocol exactly
   once: a public catalog entry is used directly, while the disposable
   qualification-only copy exists only while the package is absent from that
   catalog.
8. The idempotent completion sets only `bootstrap` and `latest`, both to
   `0.0.0`, and applies this exact deprecation message:
   `Bootstrap-only artifact; do not adopt. Use a supported
   @agent-teams/docs-protocol release candidate instead.`
9. Postconditions require the only registry version to be `0.0.0`, the exact two
   tags and deprecation above, and registry integrity equal to the local archive.
   An isolated exact install then runs
   `npm audit signatures --json --include-attestations`; success additionally
   requires one verified Docs Protocol SLSA provenance attestation with a
   retained Sigstore bundle and no invalid or missing signatures.
10. After evidence is retained, configure the normal release workflow as npm's
    trusted publisher, verify it, revoke the granular token, remove the bootstrap
    secret and enable variable, and delete the one-time workflow in a reviewed
    cleanup. Only a later normal Changesets wave may create `0.1.0-rc.0`.
11. During the Foundation-only prerelease release PR, the Changesets CLI may add
    the missing Docs Protocol `initialVersions` entry as exact `0.0.0`. The
    ReleaseGate permits only that single addition and only when both revisions
    keep the identical private `0.0.0` manifest without `publishConfig` and the
    identical Changesets configuration still ignores Docs Protocol. No hand edit
    or pre-seeding of `.changeset/pre.json` is allowed.

## Consequences

- Foundation remains the only package reachable by ordinary release automation
  throughout D' stage one.
- A retry can finish tags, deprecation, and evidence after an exact publish
  without risking a different `0.0.0` artifact.
- The unavoidable initial token is short-lived, package-scoped, approval-gated,
  and excluded from the long-term trusted-publishing path.
- A successful publish alone is insufficient: exact registry state and
  cryptographically verified provenance are required before bootstrap success.
