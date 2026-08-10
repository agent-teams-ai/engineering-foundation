# Repository Security Baseline

Status: Accepted and implemented for publishing repositories by ADR-0005 and
hardened by ADR-0009.

`repository.security-baseline` discovers every regular YAML file in the declared
workflow directory. Symlinks, unsupported entries, missing required workflows,
and malformed YAML are invalid input rather than partial success.

The combined profile applies to repositories that both run governed workflows
and publish at least one package. A non-publishing application does not invent a
package manifest to satisfy it; a future workflow-only profile is a separate
capability decision.

## Workflow controls

- every external action and reusable workflow uses a full 40-character commit
  SHA; local actions are limited to recursively inspected composite actions,
  and external container actions require a SHA-256 digest;
- every direct external `uses` entry appears in a closed consumer allowlist;
  a remote action or reusable workflow pinned by SHA is treated as one reviewed
  opaque trust root, not as proof of its internal dependency graph;
- local composite actions are traversed recursively so they cannot hide an
  unpinned or unapproved dependency;
- root `permissions` is an explicit object containing only `read` or `none`;
- a job can request `write` only when consumer policy declares its exact workflow,
  job ID, and complete permission map;
- stale privilege declarations, `write-all`, `pull_request_target`, and direct
  dot or bracket access to `github.event` and `github.head_ref` inside shell
  interpolation fail;
- every pull-request workflow that contains a `run` step, local action, or
  reusable workflow has a same-workflow pinned Dependency Review job before
  that execution; the primary CI gate is an unconditional prerequisite for
  both Linux and Windows install jobs;
- the required Linux `check` job runs Anchore SBOM without job/step conditions
  or `continue-on-error`;
- Dependency Review is bound to one declared required job, exact non-equal
  base/head expressions, an explicit vulnerability check, and a severity floor.
  Advisory mode, scope reduction, advisory exceptions, and uninspected external
  config are prohibited. The SBOM action scans the repository root and retains
  its artifact.

Actionlint and zizmor execute as separate blocking CI gates after a
script-disabled dependency install and before package lifecycle scripts are
rebuilt. The gate bootstraps only Aqua v2.62.3:
macOS/Linux archives are selected from a committed SHA-256 table, verified
before extraction, and atomically installed in a lock-protected private user
cache. Every cached executable is reverified by digest before execution;
ambient `PATH` binaries are never trusted. No binary is committed and no
floating installer is executed. Windows receives a typed unsupported-platform
precondition, and Windows CI does not call the gate. `actionlint` uses its
repository discovery mode, covering both `.yml` and `.yaml` workflow files.
`zizmor` receives the repository root with strict collection, so it also audits
checked-in composite actions outside `.github`. Aqua pins their versions, the
standard registry revision, and cross-platform artifact checksums. CodeQL runs
independently with the minimum job-level `security-events: write` permission.
Normal capability execution only validates repository state and optional
deterministic tool evidence; it never invokes these tools itself.

The offline capability cannot fetch and recursively attest remote reusable
workflow internals. Producer-owned qualification is required before claiming
that a remote trust root also pins every transitive action. Empty
`transitiveUses` declarations are therefore not interpreted as such proof.

The repository's ReviewRouter interaction entrypoint is intentionally a thin
caller of the producer-owned reusable workflow, pinned to the same immutable
revision as its `runtime_ref`. The caller owns only triggers, the human/comment
filter, least-privilege permissions, consumer variables, and secret mappings.
Checkout, runtime preparation, and discussion authentication remain in the
qualified producer workflow instead of being copied into this repository.

## Merge authority boundary

Repository-owned workflows are evidence, not their own root of trust. A pull
request can change a workflow or script while preserving a required check name;
GitHub status contexts alone therefore do not prove that the reviewed gate ran.

The current one-writer bootstrap profile relies on the platform-enforced
repository write boundary and an explicit owner merge decision. Before a second
writer, merge bot, or autonomous release actor is authorized, the repository
must add an independent control that the pull request cannot rewrite: an
external GitHub App check, an organization-managed required workflow, or a
platform-enforced approval from a distinct trusted reviewer. The required check
must be bound to its expected App source. Adding another repository-local
self-check does not satisfy this requirement.

## Package controls

Every declared publishable package enables npm provenance and uses a narrow,
literal `files` allowlist. Root, parent, glob, source, test, Git, environment,
and known local-auth paths are prohibited. This static capability does not
prove the produced tarball contents. A publishing consumer must separately run
a real tarball E2E check that proves required files, rejects forbidden paths,
and searches packed content for a source-owned secret canary before it may treat
package publication as qualified. The repository gate also proves two clean
packs are byte-identical, enforces archive size and entry-count budgets, and
rejects special tar entries.

Dependency Review blocks newly introduced vulnerable dependencies before any
repository dependency is installed. It receives event-derived base and head refs: PR
base/head commits for pull requests, before/current commits for pushes, and the
default branch/current commit for manual runs. Anchore generates an SPDX JSON
SBOM in the same Linux CI job. npm Trusted Publishing provides the package
publication provenance. These are independent controls: an SBOM lists
components, while provenance identifies the build and publisher.
