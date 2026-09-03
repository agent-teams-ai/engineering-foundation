# Docs Portable Boundary Delivery and Evidence

Status: the direct adapter split plus Repository Mutation and Document Authoring
package extractions are implemented and merged at exact head
`9fdd5e37f71ee12a228456cdebc9dd7db358ea47`. Required exact-head qualification is
green. Candidate package trees and archive integrity are reviewed in the
bootstrap catalog; protected publication and coordinated consumer rollout
remain pending.

The accepted target and sole manually maintained package DAG are in
[ADR-0043](../decisions/0043-new-only-portable-documentation-package-boundary.md).
This document tracks delivery dependencies and evidence; it does not redefine
the architecture or duplicate release order.

The bridge step in the historical pasted plan is superseded by ADR-0043 and
the accepted new-only direction. It is deliberately not a pending delivery
gate: adding a bridge, legacy root export, runtime autodetection, or automatic
migration would violate the current boundary.

## Current integration evidence

Measured against the implementation integration head on 2026-09-03. The
documentation commits may advance `main` without changing this evidence; it
remains pre-release until protected bootstrap and provenance promotion finish.

| Evidence | State | Observation |
| --- | --- | --- |
| Exact base | Bound | The package-boundary delivery is measured from `f73907741b6752a1ba57baaf516e7fcdb6e2aa9b`; implementation integration head `9fdd5e37f71ee12a228456cdebc9dd7db358ea47` is bound to post-merge CI run `33766996969` (all jobs passed) |
| Current public manifests | Measured | One manifest-derived catalog projects all six public packages and the closed ADR-0043 dependency graph |
| Physical boundaries | Measured | Foundation authoring/mutation exports and the Foundation `docs` CLI namespace are absent; portable Docs Protocol has no adapter path |
| Focused remediation | Passed | Bootstrap policy `26/26`; CLI/filesystem `58 passed` plus one intentional benchmark skip; transaction/recovery `125/125` and `51/51`; final stale assumptions `2/2` and `13/13` |
| Source Dependencies v2 | Passed | Package coverage, package/export ownership, manifest edges, cross-package relative imports, runtime/type-only cycles, and qualification coverage fail closed |
| Disposable package install | Passed (pre-release) | On exact implementation tree `9fdd5e3`, post-merge CI run `33766996969` passed npm/pnpm docs-only, MCP, and Foundation registry matrices on Linux and Windows plus macOS qualification. The same run retained candidate bootstrap evidence for all three candidate packages with archive, manifest, package-tree, and SRI receipt; no protected registry publication or real-consumer runtime action is claimed |
| Reviewed bootstrap bytes | Bound, unpublished | Ubuntu `linux-package` writer-evidence job in run `33793824242` retained the exact direct-writer archives from merge ref `c02476443e9873e2886d3a82f7384a62384e4d90`; receipt `sha256:8f07209ccdb85ff3198979a9c7dc3fd2ad70ea6f6d46f3b91a6333cb40dfcd93` binds all three catalog package trees, SHA-512 SRI values, and archive SHA-256 values. Candidate qualification remains separate and approved-only runs skip redundant packing. |

Hosted execution is currently fail-closed. A project-control admission snapshot
at `2026-09-03T12:42:58Z` reported no heavy workers running and sufficient
memory, but denied a new producer because the project retained the inactive
dirty `docauth43-core-r2` worktree. No new hosted worker was
dispatched against that state; the dirty output remains preserved for explicit
review rather than being deleted or restarted.

This table is not exact-head release proof. A checked item below requires its
own current, authoritative evidence rather than this prose.

## Document Authoring qualification lane handoff

The qualification lane started from exact base
`fe8beaa66ca963934fd027aa4501687d40117eb9`. Its six-package descriptors,
Source Dependencies v2 policy, hostile fixtures, derived release graph, package
qualification, registry-install exercise, new-only negative assertions, and
bootstrap candidate are now integrated. They become release evidence only when
the final physical package graph passes all required gates at one exact head. The
merged head now has that required CI evidence; protected bootstrap remains a
separate release gate.

`@agent-teams/repository-mutation@0.0.0`,
`@agent-teams/document-authoring@0.0.0`, and
`@agent-teams/docs-protocol-agent-teams@0.0.0` are reviewed bootstrap artifacts
after the shared journal kernel merge. The catalog binds each package tree and
archive SRI to the retained exact-head receipt. This approval permits only the
protected bootstrap workflow to re-pack and verify the same bytes; the artifacts
remain neither registry evidence nor supported releases until publication and
postcondition proof complete.

## Delivery checklist

### 1. Foundation gate

- [x] Bind the implementation change to one exact clean head and an approved
  ADR-0043 baseline promotion owned by integration.
- [ ] Inventory current exports, consumers, persisted transaction generations,
  and exact recovery artifacts before moving code or deleting an entrypoint.
- [x] Apply the extraction admission invariant: prove repeated semantics with
  parity fixtures and delete superseded duplicates instead of wrapping them.
- [x] Freeze package names, public subpaths, closed schemas, and ownership before
  package movement; reject consumer business catalogs or executable extensions.

### 2. Direct Agent Teams adapter split

- [x] Move managed implementation, assets, and Qualified Cohort integration
  directly to `@agent-teams/docs-protocol-agent-teams` and
  `agent-teams-docs-managed`; leave none in portable Docs Protocol.
- [x] Prove portable Docs Protocol and MCP have no static, type-only, dynamic,
  optional, subprocess, generated, or package-manifest path to the adapter.
- [x] Add no alias, old root export, forwarding facade, bridge release, floating
  range, runtime detection, or dual managed implementation.

### 3. Mutation and authoring extraction

- [x] Extract the first coherent Repository Mutation leaf at the ADR-0043
  boundary, directly rewire current generic callers, and remove the Foundation
  mutation facade. Document Authoring remains in Foundation for the next lane.
- [x] Extract Document Authoring with exact public API, package-content, and
  parity evidence.
- [x] Preserve canonical Markdown/YAML, data-only profiles, disposable
  projections, exact-preimage application, bounded journals, and distinct
  Plans/Receipts/recovery handlers.
- [x] Retain exact-build recovery for every admitted in-flight transaction;
  incompatible or ambiguous evidence must block mutation without rewriting it.

Repository Mutation protects the cooperative common lock and journal evidence.
A standalone portable caller does not classify an unaccompanied Foundation
orphan backup; full Foundation local-mode admission remains in Foundation's
composition wrapper. This ownership limit does not permit unknown common
journals to be ignored or treated as idle.

### 4. Derived package release qualification

- [x] Make Source Dependencies v2 reject every failure class listed in ADR-0043,
  with positive and hostile fixtures and separate runtime/type-only cycle proof.
- [x] Record artifact-qualification coverage for every public package and permitted edge;
  missing coverage must fail closed without inventing a source edge.
- [x] At the exact release head, derive package publication order solely by
  topologically sorting exact internal manifest dependencies; reject drift,
  cycles, undeclared packages, missing coverage, or a manual order authority.

### 5. Disposable install and hostile evidence

- [x] Pack reviewed artifacts and perform clean exact-version npm and pnpm
  installs in disposable repositories with scripts/hooks disabled where the
  contract requires.
- [x] Exercise public imports, CLI startup, portable authoring, adapter commands,
  and MCP transport from installed artifacts, not workspace source.
- [ ] Exercise path aliases, cross-package relatives, unexported subpaths,
  adapter discovery attempts, stale plans, changed preimages, crashes, version
  skew, incompatible journals, malicious document content, and resource limits.
- [x] Retain supported Linux, macOS, and Windows evidence without claiming POSIX
  hard-power-loss durability on Windows.

The hostile matrix is exercised by the exact-head built suites and the
disposable registry run above. The remaining unchecked box is intentionally
kept until a single machine-readable hostile-run receipt binds every case to a
published artifact; the current evidence is still sufficient to prevent a
false release claim:

| Case | Evidence source | Current result |
| --- | --- | --- |
| Path aliases, cross-package relatives, hidden/unexported subpaths | `source-dependency-workspace-topology.test.mjs`, `source-dependency-workspace-discovery.test.mjs`, `source-dependency-development-mode.test.mjs` | Passed in `pnpm test:built` |
| Adapter discovery and portable closure | `document-authoring-package-boundary.test.mjs`, `package-boundary.test.mjs`, registry package-boundary checks | Passed |
| Stale plans, changed preimages, cancellation, and transaction barriers | `document-authoring-plan-validation-hostile.test.mjs`, `document-authoring-application-use-cases.test.mjs`, `known-file-transaction-*` suites | Passed |
| Crashes, version skew, incompatible journals | `registry-document-authoring-e2e.mjs`, `document-authoring-writer-crash.test.mjs`, `document-authoring-version-compatibility.test.mjs` | Passed in disposable registry / built suites |
| Malicious content and resource bounds | `document-authoring-canonical-markdown.test.mjs`, `document-authoring-contracts.test.mjs`, `registry-docs-protocol-mcp-e2e.mjs` | Passed |

### 6. Current-consumer migration preparation

The first inventory checkpoint is recorded in
[Portable Documentation Consumer Inventory](docs-portable-consumer-inventory.md).
It identifies `agent-teams-orchestrator` at an exact commit, but persisted
transaction generations and published target coordinates are still unknown.

- [ ] Inventory every current consumer at an exact commit, including legacy
  entrypoint/export use and every admitted persisted transaction generation.
- [ ] Prepare and review, but do not merge, explicit coordinated changes with
  intended exact coordinates, lockfile updates, new-only imports,
  managed-adapter placement, recovery instructions, and required-check plans.
- [ ] Bind an approved publication, consumer-rollout, and recovery plan to the
  exact packed artifacts and inventoried commits. Prove the prepared path needs
  no bridge, runtime autodetection, or automatic migration.

### 7. Exact-head integration checks

- [x] Re-read HEAD and reject a base or ownership mismatch; inspect the complete
  diff and accepted-decision baseline promotion at that same head.
- [x] Run `pnpm check:changed` while integrating, then `pnpm check:fast` before
  handoff and `pnpm verify` before the pull request. Record real outcomes rather
  than treating this phase-0 NOT RUN state as success.
- [x] Obtain the required exact-head Linux, Windows, macOS, dependency, package,
  recovery, security, and independent review evidence.

### 8. Protected provenance publication and consumer adoption

- [ ] Publish only immutable reviewed versions from protected provenance after
  all upstream exact artifacts and artifact-qualification evidence pass.
- [ ] Re-prove manifest, tarball, SRI, signature, source-bound provenance, SBOM,
  final tags, and installed dependency resolution before downstream publication.
- [ ] On partial or uncertain publication, observe and fail closed; merge no
  consumer migration and never overwrite or unpublish a version, fill an invalid
  upstream hole, or weaken a gate.
- [ ] After exact registry and provenance proof for the required package set,
  merge/adopt prepared consumer changes with exact published pins in the
  approved order and run each consumer's complete required hosted checks.
- [ ] Prove fleet closure at exact consumer commits: clean registry lockfiles,
  new-only imports, direct managed-adapter ownership, admitted recovery support,
  and zero bridge or legacy-entrypoint need.

## Explicit exclusions

This delivery selects no documentation site generator, portal, visual search UI,
universal plugin platform, daemon, automatic prose acceptance, speculative
infrastructure, installation on a real project, or unreviewed consumer mutation.
