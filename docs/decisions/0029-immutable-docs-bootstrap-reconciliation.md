---
id: ADR-0029
status: accepted
supersedes:
  - ADR-0028
superseded_by: []
---

# ADR-0029: Immutable Docs Bootstrap Reconciliation

Status: Accepted

Date: 2026-08-14

Decision owner: Product owner

## Context

ADR-0028 established a fail-closed first publication, but its token prerequisite
cannot be satisfied before npm knows the package name, and its `latest` tag would
make a bootstrap-only artifact look adoptable. The promotion, provenance, npm
state, Git tag, and GitHub release must bind to one reviewed commit without
allowing an immutable bad publication to be silently replaced.

## Decision

1. The official empty Changeset, public Docs Protocol `0.0.0` manifest,
   Changesets ignore removal, public provenance configuration, changelog entry,
   and publishable-package catalog entry are one promotion PR. The empty
   Changeset parses as release evidence with no package releases and must be
   consumed or removed by Changesets. A generated release PR still requires at
   least one non-empty package release Changeset.
2. The manual workflow remains dormant until Foundation `0.17.0-rc.0` exists on
   npm. Ordinary Changesets publication recognizes the public catalog entry but
   cannot create a missing Docs Protocol `0.0.0` baseline.
3. The initial credential is a granular read/write token restricted to the
   existing `@agent-teams` scope because npm cannot grant access to a package
   that does not yet exist. It expires within 24 hours. Bypass 2FA is enabled
   only when npm requires it for this publication. The protected environment
   exposes it as `NODE_AUTH_TOKEN` only to the state-changing npm step. The token
   and secret are revoked immediately after verified reconciliation.
4. One reviewed tarball is packed without lifecycle scripts, checked against a
   closed inventory, bound to exact Foundation `0.17.0-rc.0`, and assigned one
   canonical SHA-512 SRI. That same file is published with
   `--tag bootstrap --provenance --ignore-scripts`; no rebuild is permitted.
5. Preflight accepts only an absent package or an existing sole version `0.0.0`
   whose SRI equals the reviewed tarball and whose tags are a subset of the
   bootstrap-only final state. Every other registry state fails closed.
6. Final npm state contains only version `0.0.0`, only
   `bootstrap: 0.0.0`, no `latest` or `rc`, and the exact bootstrap deprecation.
7. Signature audit evidence must contain exactly one Docs Protocol SLSA v1
   provenance bundle. Its in-toto subject is the exact package name and version
   with the local tarball SHA-512 digest. Its build definition names repository
   `agent-teams-ai/engineering-foundation`, workflow
   `.github/workflows/docs-protocol-bootstrap.yml`, protected main, and the exact
   reviewed promotion commit.
8. Only after npm SRI, deprecation, tags, signatures, and provenance pass, a
   separate job receives `contents: write`. The npm credential is absent from
   that job. It creates the lightweight tag
   `@agent-teams/docs-protocol@0.0.0` when absent, reuses only the same reviewed
   commit, and fails on any mismatch. It creates or reuses only an exact
   non-draft GitHub prerelease targeted at that commit. The final tag and release
   API responses are retained as reconciliation evidence.
9. Registry and GitHub reconciliation never overwrite or silently normalize
   conflicting evidence. A mismatch stops the workflow for owner review.
10. npm versions are immutable. If publish succeeds but provenance later proves
    missing or invalid, do not unpublish and do not reuse or overwrite `0.0.0`.
    Deprecate the bad immutable bootstrap, remove any adoptable dist-tags, and
    advance only through a separately reviewed next bootstrap version or release
    candidate. Restore the exact approved tags only after that new artifact's
    SRI and provenance pass. Record the incident and retained evidence before
    enabling normal publishing.
11. After successful reconciliation, configure and verify npm trusted
    publishing, revoke the granular token, remove the environment secret and
    enable variable, and delete the one-time workflow in a reviewed cleanup.

## Consequences

- The promotion is review-atomic while the hosted bootstrap remains dormant
  until its Foundation prerequisite exists.
- The bootstrap artifact can never become `latest` or `rc`.
- npm and GitHub evidence converge on one reviewed commit and one tarball.
- A provenance failure consumes the immutable version and requires an explicit
  owner-approved recovery instead of replacement or unpublish.
