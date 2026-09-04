# Release Procedure

All ordinary releases of packages in the reviewed public-package catalog use
npm Trusted Publishing from the protected `main` workflow with GitHub OIDC and
automatic provenance. Manual workstation publication and persistent npm secrets
are not supported.
The sole exception is the reviewed one-time namespace bootstrap in ADR-0044;
it cannot publish a supported release.

Changesets maintains versions and release notes. The release workflow publishes
only from protected `main`.

Release agents derive every exact current version from the reviewed manifests,
Changesets state, and registry evidence; this runbook intentionally carries no
mutable "current version" copy. Normal package changes enter the ordinary
Changesets flow described below; the completed namespace bootstrap and D'/RC
rollout are not prerequisites to rerun.

## Completed bootstrap history

The D' rollout first published Foundation `0.17.0-rc.0`, then promoted Docs
Protocol from its exact public `0.0.0` namespace baseline into the bounded
catalog and passed the packed pair through artifact qualification in the RC
waves. The subsequent
stable Foundation and Docs Protocol releases are recorded by their package
changelogs, immutable registry versions, Git tags, and GitHub releases. This
paragraph records completed history; it is not an executable release checklist.

The one-time ADR-0029 namespace bootstrap is likewise completed historical
evidence. Do not rerun its retired workflow. ADR-0044 now owns the single generic
closed-catalog mechanism for an explicitly approved future namespace and keeps it
separate from ordinary OIDC release authority. Never edit package versions or
`.changeset/pre.json` by hand.

The ADR-0044 batch completed on 2026-09-04. Exact `0.0.0` namespace baselines for
`@agent-teams/repository-mutation`, `@agent-teams/document-authoring`, and
`@agent-teams/docs-protocol-agent-teams` were provenance-verified and deprecated
as bootstrap-only artifacts by runs `33820083046`, `33825555921`, and
`33839138339`. Their catalog entries are historical, but ordinary releases still
verify each immutable baseline. The bootstrap repository variable is disabled,
the short-lived GitHub secret was removed, and no persistent npm credential is
part of the release path.

## One-time namespace bootstrap

`architecture/foundation/npm-package-bootstrap.json` is the only package-specific
authority. The selected profile must be `approved` with reviewed package-tree and SRI
evidence before the protected `npm-package-bootstrap` environment can run. The
SRI must come from the retained Ubuntu writer artifact with the repository-pinned
Node and pnpm versions, never from a local `npm pack` or `pnpm pack`: gzip bytes
are platform-specific even when the underlying tar payload is identical. The
environment reviewer verifies the granular token is scoped for the one bootstrap,
was created at the dispatch timestamp, expires within 24 hours, and has at least
15 minutes remaining. Only then may the manual workflow run on the exact reviewed
protected-main commit.

The workflow performs one publish attempt only after the complete local and npm
preflight. Public npm may expose only the requested `bootstrap` tag or may also
create `latest` for a namespace's first version. The workflow never creates,
removes, or moves either tag explicitly. Normal publish or reuse requires
`bootstrap -> 0.0.0`, allows only an optional `latest -> 0.0.0`, and re-proves
exact SRI, signature, publish attestation, and source-bound SLSA
provenance before deprecation. If publication is uncertain and provenance cannot
be proved, rerun only the reviewed `quarantine` operation: it may deprecate the
exact reviewed bytes but cannot publish, move tags, reconcile a GitHub release,
or satisfy the ordinary release gate. Retain the evidence, revoke the token,
disable the workflow, and require a successor ADR plus newly reviewed version
path if provenance never converges. After each exact normal postcondition and
GitHub prerelease is retained as evidence, configure npm Trusted Publisher for
that package, revoke its one-package token immediately, and remove the GitHub
environment secret. Bootstrap dependent packages strictly in catalog dependency
order with a fresh token for each package. Disable the bootstrap repository
variable after the approved batch and confirm cleanup before merging the release
PR.

The ordered release command does not complete after npm publication alone. Its
final required phase resolves the canonical public Docs Protocol coordinates and
installs docs-only plus docs-and-MCP profiles through both npm and pnpm in fresh
disposable repositories. It also requires each canonical coordinate to own its
exact `latest` tag and SHA-512 integrity, verifies both npm signature and SLSA
provenance statements in one disposable npm audit, and binds the stable Git tag
and read-only GitHub release observation to the shared provenance commit.
Missing coordinates or any failed supply-chain, installed CLI, or MCP flow
leaves the release run failed and blocks completion evidence.

## Current stable procedure

### Public managed registry canary

After the pre-registration registry E2E has proved all five packages and the
candidate is explicitly registered in the central Cohort registry, dispatch
`Public managed registry canary` from the exact protected-main integration
commit. Supply only the Cohort ID and the exact current protected-main revision
of `agent-teams-ai/.github`. Trusted code reads and schema-validates the registry
at that immutable revision, explicitly requests generation 2, and projects the
single canary-eligible record. The workflow has read-only repository permission,
receives no secrets or OIDC authority, and never publishes, deprecates,
unpublishes, or moves a dist-tag.

The canary installs exactly Foundation, Docs Protocol, and the managed adapter as
three roots in fresh npm and pnpm projects; Repository Mutation and Document
Authoring must resolve only as their exact transitives. It cryptographically
verifies npm signatures, records each package's SLSA provenance commit and its
ancestor relationship to the integration commit, and re-observes `latest` and
SRI. On the disposable pnpm lockfile, qualification v3 first observes the actual
runtime closure digest and then admits the same trusted Cohort v2. It also
generates managed-state v2 and validates it against the installed schema without
running a real consumer or mutation flow. Cohort authority remains exactly these
five packages and continues to reject MCP in its npm and pnpm closures.

The six-package release claim has one separate supporting precondition:
`@agent-teams/docs-protocol-mcp@0.2.0`. A fresh npm consumer pins that package
beside the Cohort's exact Docs Protocol coordinate. The gate requires the MCP
version to own `latest`, captures and validates its registry lock and SHA-512
SRI, verifies its npm signature and SLSA provenance, proves the provenance
commit is an ancestor of the integration commit, and checks the downloaded
tarball inventory. Only after those checks does it start the installed stdio
server, validate the three read-only tools, execute them against a disposable
fixture, prove the fixture tree is unchanged, and require a clean shutdown.

A separate portable-only install proves that core does not resolve the managed
adapter. Tarball path/alias checks and bounded hostile policy cases fail closed.
The retained JSON artifact is the sole canary receipt; it represents the five
Cohort packages and the separate supporting MCP precondition, and its canonical
SHA-256 digest covers every field except the digest itself. A successful canary
is release evidence, not permission to modify a real consumer.

Release-candidate waves use committed Changesets prerelease state with the exact
`rc` tag. Changesets remains the sole version and changelog authority, but the
publish step is deliberately ordered rather than delegated to concurrent
workspace publication. It packs every reviewed artifact and derives the
publication order by topologically sorting the exact internal dependencies from
the reviewed workspace manifests. The projection must equal the closed
six-package DAG owned solely by
[ADR-0043](decisions/0043-new-only-portable-documentation-package-boundary.md);
no second hand-maintained package list or release order is authoritative.
Publication uses the resulting order under the final `rc` or `latest` tag with
npm Trusted Publishing and the npm version
bundled by the pinned Node runtime. No npm token is stored. Immediately before
each npm write, the live protected
`refs/heads/main` must still equal the run's exact `GITHUB_SHA`; an older run may
inspect and reconcile an already-published exact pair but cannot publish a
missing version after `main` advances. A current exact-main run may publish a
missing Docs Protocol patch against an already-published Foundation version only
after proving the local Foundation tarball, complete manifest, final tag,
cryptographically verified provenance, and protected-main ancestry. Only after
npm exposes the exact SRI, tarball manifest,
trusted provenance, source repository, workflow and commit does it run npm's
cryptographic signature and attestation audit. Release authority is derived
only from the exact SLSA statement inside that npm-verified Sigstore bundle,
including package subject, tarball SRI, repository, workflow, ref and commit.
Separately fetched registry attestation data is only supplementary and must
agree with the verified statement. Only a clean exact-package signature result
permits the next package in topological order to publish under the same final
tag. Every package must pass the same audit before Git tags or GitHub releases
are reconciled. For every dependency edge, the publisher requires the upstream
package's `published_at` to be no later than the downstream package's timestamp.
After all signature checks it re-reads every exact tarball, final tag, SRI and provenance before
creating any GitHub release. The short interval where only Foundation's final
tag has moved is non-authoritative: consumer admission starts only after the
exact package graph receives its external artifact qualification.

A repository gate discovers every non-private direct package under `packages/`
and requires the same package names in the existing public API compatibility,
publishable-package, and registry artifact-qualification authorities. The gate reads
those owners directly; it is a completeness contract, not another package list
or release dependency graph.

The ordered publisher also owns idempotent Git tag and GitHub release
reconciliation. The Changesets action's built-in GitHub release creation is
disabled because concurrent workspace publication is not retry-safe. Existing refs and
releases are reused only when their commit, prerelease flag, title and exact
Changesets changelog body match. A partial boundary is completed on retry.
Later `main` commits accept only package provenance from a verified protected-main
ancestor and require intact final tags. An already-published exact graph performs
no npm writes and emits no `New tag:` lines. A current exact-main patch may reuse
already-proven dependencies and publish only the missing dependency-closed set in
reviewed topological order. It emits one parser-compatible line for every package
completed by the current provenance commit after all npm and GitHub postconditions
have converged.

A partial retry never uses `npm dist-tag`, overwrites or unpublishes an
immutable npm version. It may skip an existing version only when its SRI,
complete packed manifest and trusted source provenance exactly match the local
reviewed artifact. A later exact protected-main run may publish a partial
release's missing dependency-closed set only after every existing dependency
passes the reusable-artifact proof. Before the first publication, every exact
package state is inspected; a graph with a published package whose required
upstream dependency is missing is quarantined without filling that upstream
hole. A timeout, 5xx,
unknown publish result or temporarily missing version is retried only as a
read-only registry observation. Persistent uncertainty fails closed. Any
identity mismatch requires quarantine/deprecation and an explicitly reviewed
new version; no further publication or GitHub release reconciliation occurs.
Contradictory, mixed or unknown prerelease state still fails before npm
publication, and an RC cannot move `latest`. Returning to stable publication
requires a separately reviewed Changesets prerelease-exit change.

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
`windows-check`, and `macos-qualification` commit statuses. The other canonical
required contexts remain the CodeQL-owned `CodeQL` and `analyze` checks. The
release attester fails closed on ambiguous
selection, a rerun attempt, a terminal approval-blocked run, changed provenance,
an unexpected PR, forbidden diff, missing result, timeout, head change, or failed
conclusion.
Independent hosted review is recorded in pull-request comments and is not
self-attested into a repository status. The obsolete `ReviewGate` workflow and
required context were retired when repository governance decoupled hosted review
from ReviewRouter OAuth. The stable required contexts remain `CodeQL`, `analyze`,
`check`, `windows-check`, and `macos-qualification`; each applies to the exact
pull-request head. The Changesets action does not receive status or Actions write
permission, and no release-branch code runs with write credentials. If automatic
pull request creation is unavailable, prepare the same
version commit on a short `chore/release-*` branch, open a normal pull request,
and let the unchanged release workflow publish its merge through npm Trusted
Publishing. Never weaken branch protection or publish from a workstation to work
around the policy.

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
- pass the hermetic npm-compatible registry publish/install artifact qualification;
- rerun the hardened qualifier with the exact pinned Buf `FILE` policy;
- retain the CI-generated SPDX JSON SBOM and npm Trusted Publishing provenance
  as separate supply-chain evidence.

The exact generated release PR must pass the protected cross-platform repository
checks before merge. A fresh publish runner builds the reviewed sources once to
materialize package artifacts. `release:publish` does not repeat the full
repository suite on the same reviewed artifact tree; it then runs the
release-only pinned Buf capability qualification, hermetic registry artifact qualification,
published-version compatibility checks, and ordered publication.
The registry artifact qualification starts an isolated
npm-compatible registry with no uplinks, publishes the packed package and its
runtime dependency closure, installs by exact version, and verifies registry
metadata, lockfile integrity, CLI startup, and public imports.

The test suite also exercises the production operation lock across real child
processes, including live-owner rejection, dual-reclaimer serialization, and
ownership-fenced recovery after a same-host owner is killed. Published-version
compatibility qualification installs the pinned npm 0.11 package and proves that a current v2
transaction barrier blocks its recover, attach, and detach mutations without
changing consumer evidence. Mutation-boundary recovery remains covered by
deterministic state fixtures. Windows does not claim POSIX-equivalent hard
power-loss durability because Node cannot portably fsync directories there.
