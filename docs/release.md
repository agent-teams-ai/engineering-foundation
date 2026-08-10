# Release Procedure

The first public `@agent-teams/engineering-foundation` release is bootstrapped
manually with npm 2FA after `pnpm check` passes. After that release:

1. configure this repository and release workflow as the package's npm trusted
   publisher;
2. enable GitHub OIDC publishing and automatic provenance;
3. revoke any temporary automation write token;
4. require the release PR and complete CI before publication.

Changesets maintains versions and release notes. The release workflow publishes
only from protected `main`.

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
creation is allowed during capability adoption. Multi-package promotion is
validation-first and replay-safe after a partial process failure: an unchanged
already-promoted package is skipped, while same-version API drift fails closed.

Automatic Changesets pull requests require the organization setting that permits
GitHub Actions to create pull requests. The organization allows this capability,
but it is enabled at repository level only for `engineering-foundation`; other
repositories keep it disabled unless they acquire an approved release workflow.
All workflows still receive read-only permissions by default, and the foundation
release workflow requests only the permissions it needs. Pull requests created
with `GITHUB_TOKEN` do not recursively emit another workflow event, so the
release workflow explicitly dispatches the read-only CI workflow against the
generated release branch. GitHub does not attach manually dispatched checks to
the pull request's required-check rollup. A separate attestation job therefore
verifies the exact open release PR SHA and the narrow generated-file allowlist,
waits for both expected GitHub Actions jobs, and publishes their real conclusions
as `check` and `windows-check` commit statuses. It publishes `ReviewGate` only
for that bounded generated release diff; it does not claim an external
ReviewRouter review. The release attester fails closed on an unexpected PR,
forbidden diff, missing result, timeout, head change, or failed conclusion.
Source pull requests still require the independent ReviewRouter gate before
merge. The Changesets action does not receive status or Actions write
permission, and no release-branch code runs with write credentials. If automatic
pull request creation is unavailable, prepare the same
version commit on a short `chore/release-*` branch, open a normal pull request,
and let the unchanged release workflow publish its merge through npm Trusted
Publishing. Never weaken branch protection or publish from a workstation to work
around the policy.

The default-branch `workflow_run` publisher reports whether it safely inspected
and published the exact-head `ReviewGate`; it does not copy the pull request's
pass/fail result onto the default-branch check run. A missing or failed App
review remains a failing `ReviewGate` status on the pull request head, while a
successful publication job stays green. Invalid or unbound workflow evidence
still fails the publisher before it can write a status.

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

`release:publish` runs the real pinned Buf qualification and hermetic registry
qualification after the normal repository checks and before `changeset publish`.
The registry qualification starts an isolated
npm-compatible registry with no uplinks, publishes the packed package and its
runtime dependency closure, installs by exact version, and verifies registry
metadata, lockfile integrity, CLI startup, and public imports.

The test suite also exercises the production operation lock across real child
processes, including live-owner rejection and stale-lock recovery after the
owner is killed. Mutation-boundary recovery remains covered by deterministic
state fixtures. Windows does not claim POSIX-equivalent hard power-loss
durability because Node cannot portably fsync directories there.
