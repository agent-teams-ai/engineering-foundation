# Release Procedure

All current Foundation and Docs Protocol releases use npm Trusted Publishing
from the protected `main` workflow with GitHub OIDC and automatic provenance.
Manual workstation publication and stored npm credentials are not supported.

Changesets maintains versions and release notes. The release workflow publishes
only from protected `main`.

During the D' stage-one rollout, Foundation `0.17.0-rc.0` publishes first. The
same Docs Protocol promotion PR carries the official empty Changeset, exposes
the exact public `0.0.0` manifest, removes the Changesets ignore, and adds the
package to the bounded public catalog. Ordinary release automation still cannot
create the missing stable baseline: it fails closed until the bootstrap proves
that exact `0.0.0` already exists on npm. Hermetic registry qualification uses
the public catalog entry directly and binds it to the exact packed Foundation
version.

Release-candidate waves use committed Changesets prerelease state with the exact
`rc` tag. Changesets remains the sole version and changelog authority, but the
publish step is deliberately ordered rather than delegated to concurrent
workspace publication. It packs both reviewed artifacts, proves that Docs
Protocol names the exact packed Foundation version, and publishes Foundation
directly under the reviewed final `rc` or `latest` tag using npm Trusted
Publishing with the npm version bundled by the pinned Node runtime. No npm
token is stored. Immediately before each npm write, the live protected
`refs/heads/main` must still equal the run's exact `GITHUB_SHA`; an older run may
inspect and reconcile an already-published exact pair but cannot publish a
missing version. Only after npm exposes the exact SRI, tarball manifest,
trusted provenance, source repository, workflow and commit does it run npm's
cryptographic signature and attestation audit. Release authority is derived
only from the exact SLSA statement inside that npm-verified Sigstore bundle,
including package subject, tarball SRI, repository, workflow, ref and commit.
Separately fetched registry attestation data is only supplementary and must
agree with the verified statement. Only a clean exact-package signature result
permits Docs Protocol publication under the same final tag. Docs Protocol must
pass the same audit before Git tags or GitHub releases are reconciled. It
additionally requires
`Foundation published_at <= Docs Protocol published_at`. After both signature
checks it re-reads both exact tarballs, final tags, SRI and provenance before
creating any GitHub release. The short interval where only Foundation's final
tag has moved is non-authoritative: consumer admission starts only after the
exact pair receives an external Qualified Cohort.

The ordered publisher also owns idempotent Git tag and GitHub release
reconciliation. The Changesets action's built-in GitHub release creation is
disabled because its two-package boundary is not retry-safe. Existing refs and
releases are reused only when their commit, prerelease flag, title and exact
Changesets changelog body match. A partial boundary is completed on retry.
Later `main` commits accept only package provenance from a verified protected-main
ancestor, require intact final tags, perform no npm writes, and emit no `New tag:`
lines. A same-release-commit retry emits the two parser-compatible lines only
after npm and GitHub postconditions have converged.

A partial retry never uses `npm dist-tag`, overwrites or unpublishes an
immutable npm version. It may skip an existing version only when its SRI,
complete packed manifest and trusted source provenance exactly match the local
reviewed artifact. A Foundation-only partial release can publish its missing
Docs Protocol partner only while the current run SHA is the commit named by
Foundation's verified provenance; a later unrelated `main` run performs no npm
write. Before the first publication, both exact package states are inspected;
a Docs-only state is quarantined without publishing Foundation. A timeout, 5xx,
unknown publish result or temporarily missing version is retried only as a
read-only registry observation. Persistent uncertainty fails closed. Any
identity mismatch requires quarantine/deprecation and an explicitly reviewed
new version; no further publication or GitHub release reconciliation occurs.
Contradictory, mixed or unknown prerelease state still fails before npm
publication, and an RC cannot move `latest`. Returning to stable publication
requires a separately reviewed Changesets prerelease-exit change.

Do not introduce Docs Protocol into the active Foundation 0.16 RC wave. First
qualify and release stable Foundation 0.16.0 through a reviewed prerelease exit.
Then rebase the unified-protocol feature, enter a fresh `rc` wave through the
Changesets CLI, and let its Foundation-only minor Changeset generate
Foundation 0.17.0-rc.0. Docs Protocol must remain private and exactly 0.0.0 in
this release PR. Never edit Foundation versions or `.changeset/pre.json` by hand.

The one-time ADR-0029 namespace bootstrap is completed historical evidence, not
an executable release procedure. Do not rerun its retired workflow. Any future
namespace bootstrap requires a new reviewed ADR and must not weaken this
repository's OIDC-only current release boundary.

Every pull request that changes a published package must include a normal
Changeset. CI enforces this with the official `changeset status` command against
the pull request's exact base commit. Repository-only tests, CI configuration,
and internal documentation remain release-neutral unless they change a
published contract or package artifact.

The generated release pull request is accepted only when its single release
commit is based directly on the exact `main` revision processed by the Release
workflow. Every package Changeset present at that revision must be consumed, its
summary must appear in the generated changelog, and the `# Releases` section of
the pull request body must exactly match that changelog entry. The attester
checks this evidence both before dispatching exact-head CI and immediately
before publishing successful required statuses. A newer push to `main` or a
release-head update therefore fails the old attestation until the next queued
Release run regenerates the pull request. Protected `main` also requires the
pull request branch to remain current, closing the final merge race after
attestation.

The attestation job provisions the repository's pinned Node and pnpm versions,
then installs the frozen lockfile with dependency lifecycle scripts disabled
before running its local evidence validators. A dependency bootstrap failure is
therefore an attestation failure and retains the same fail-closed status path.
After Changesets creates or updates the release pull request, the release job
polls for a bounded period until the remote release branch, pull request number,
base, head, current `main`, generated-file allowlist, and freshness proof agree.
It rechecks that tuple before exposing it to the attestation job. The attester
then binds both its initial and final checks to that exact number, base, and head.

Publication packages accepted implementations; it does not activate a capability
inside any consumer. Consumers retain exact pins and adopt a capability in a
separate reviewed change after its consumer-owned gates pass.

`pnpm release:version` runs Changesets, rebuilds declarations, and invokes
`public-api-promote-release`. Promotion requires a newer sufficient package
version and accepted evidence for every breaking fingerprint. Existing API
baselines are mutable only in `changeset-release/main`; first-time baseline
creation is allowed during capability adoption only for a declared package at
exact version `0.0.0` with a minor or major Changeset. That bootstrap extracts
the real declarations and uses create-no-replace publication; missing baselines
for any later version fail closed. Multi-package promotion is validation-first
and replay-safe after a partial process failure: an unchanged already-promoted
package is skipped, while same-version API drift fails closed.

Automatic Changesets pull requests require the organization setting that permits
GitHub Actions to create pull requests. The organization allows this capability,
but it is enabled at repository level only for `engineering-foundation`; other
repositories keep it disabled unless they acquire an approved release workflow.
All workflows still receive read-only permissions by default, and the foundation
release workflow requests only the permissions it needs. Pull requests created
with `GITHUB_TOKEN` are not guaranteed to emit another workflow event. The
attester therefore waits briefly for one unique attempt-1 `pull_request` CI run
bound to the exact repository, PR number, base, head, branch, workflow path, and
Actions URL. It reuses that run when present instead of launching a duplicate
full suite; otherwise it explicitly dispatches read-only CI against the generated
release branch. Pull request and dispatched CI use event-separated concurrency
groups, so the fallback cannot cancel required PR CheckRuns.

GitHub does not attach manually dispatched checks to the pull request's
required-check rollup. The attester verifies the selected run again while waiting
and immediately before publishing its real conclusions as `check`,
`windows-check`, and `macos-qualification` commit statuses. `ReviewGate` is
published only for that bounded generated release diff; the other canonical
required contexts remain the CodeQL-owned `CodeQL` and `analyze` checks. No
context is removed or bypassed. The release attester fails closed on ambiguous
selection, a rerun attempt, a terminal approval-blocked run, changed provenance,
an unexpected PR, forbidden diff, missing result, timeout, head change, or failed
conclusion.
Source pull requests still require the independent ReviewRouter gate before
merge. The Changesets action does not receive status or Actions write
permission, and no release-branch code runs with write credentials. If automatic
pull request creation is unavailable, prepare the same
version commit on a short `chore/release-*` branch, open a normal pull request,
and let the unchanged release workflow publish its merge through npm Trusted
Publishing. Never weaken branch protection or publish from a workstation to work
around the policy.

The default-branch `status` publisher runs only for a successful `ReviewRouter`
status created by the expected GitHub App. It resolves the review run from the
same-repository Actions target URL, binds that completed `pull_request_target`
run to one open same-repository pull request at the exact head, and re-reads the
App-owned status before publishing `ReviewGate`. The webhook `sender` is only an
early event filter; the freshly read commit-status `creator` remains the
authorization proof. A missing, failed, stale, or unbound review cannot produce
a successful gate.

If GitHub does not emit a new `workflow_run` event after a successful job rerun,
send the `review-gate-recover` repository dispatch with that completed
ReviewRouter Actions run ID in `client_payload.review_run_id`. Repository
dispatches execute the workflow from the default branch, so a pull request
cannot replace the privileged verifier. The recovery path still requires one
open same-repository pull request at the exact run head and a matching App-owned
`ReviewRouter` status before it can publish `ReviewGate`. It is not a manual
approval or a branch-protection bypass.

Before every publication:

- verify that the repository still satisfies the independent merge-authority
  prerequisite in the security baseline; the one-writer bootstrap profile is
  not valid after another writer or merge automation is enabled;
- build from a clean checkout;
- run lint, typecheck, tests, publint, and Are The Types Wrong;
- pack the real tarball;
- install it into an isolated consumer;
- verify public exports, CLI startup, and package self-check;
- verify that local tarball overrides are rejected as registry provenance;
- verify development-only dependency placement;
- reject unexpected or sensitive package contents;
- pass the hermetic npm-compatible registry publish/install qualification;
- rerun the hardened qualifier with the exact pinned Buf `FILE` policy;
- retain the CI-generated SPDX JSON SBOM and npm Trusted Publishing provenance
  as separate supply-chain evidence.

The exact generated release PR must pass the protected cross-platform repository
checks before merge. A fresh publish runner builds the reviewed sources once to
materialize package artifacts. `release:publish` does not repeat the full
repository suite on the same reviewed artifact tree; it then runs the
release-only pinned Buf qualification, hermetic registry qualification,
published-version compatibility checks, and ordered publication.
The registry qualification starts an isolated
npm-compatible registry with no uplinks, publishes the packed package and its
runtime dependency closure, installs by exact version, and verifies registry
metadata, lockfile integrity, CLI startup, and public imports.

The test suite also exercises the production operation lock across real child
processes, including live-owner rejection, dual-reclaimer serialization, and
ownership-fenced recovery after a same-host owner is killed. Published-version
qualification installs the pinned npm 0.11 package and proves that a current v2
transaction barrier blocks its recover, attach, and detach mutations without
changing consumer evidence. Mutation-boundary recovery remains covered by
deterministic state fixtures. Windows does not claim POSIX-equivalent hard
power-loss durability because Node cannot portably fsync directories there.
