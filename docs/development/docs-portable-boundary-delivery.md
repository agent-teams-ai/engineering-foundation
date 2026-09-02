# Docs Portable Boundary Delivery and Evidence

Status: the direct adapter split plus Repository Mutation and Document Authoring
package extractions are implemented on the integration branch. Exact-head full
qualification, protected publication, and coordinated consumer rollout remain
pending.

The accepted target and sole manually maintained package DAG are in
[ADR-0043](../decisions/0043-new-only-portable-documentation-package-boundary.md).
This document tracks delivery dependencies and evidence; it does not redefine
the architecture or duplicate release order.

## Current integration evidence

Measured on the integration branch on 2026-09-02. These observations remain
pre-release evidence until one exact reviewed head passes every required gate.

| Evidence | State | Observation |
| --- | --- | --- |
| Exact base | Bound | Extraction began from `fe8beaa66ca963934fd027aa4501687d40117eb9`; integration includes current main `e000fcbfdc87bf0cfa966b45034514dcc973ec51`; the PR head and its CI run own the final exact-head coordinate |
| Current public manifests | Measured | One manifest-derived catalog projects all six public packages and the closed ADR-0043 dependency graph |
| Physical boundaries | Measured | Foundation authoring/mutation exports and the Foundation `docs` CLI namespace are absent; portable Docs Protocol has no adapter path |
| Focused remediation | Passed | Bootstrap policy `26/26`; CLI/filesystem `58 passed` plus one intentional benchmark skip; transaction/recovery `125/125` and `51/51`; final stale assumptions `2/2` and `13/13` |
| Source Dependencies v2 | Passed | Package coverage, package/export ownership, manifest edges, cross-package relative imports, runtime/type-only cycles, and qualification coverage fail closed |
| Disposable package install | In progress | Local tarball graph defects are fixed as encountered; no registry publication or real-consumer runtime action is claimed |

This table is not exact-head release proof. A checked item below requires its
own current, authoritative evidence rather than this prose.

## Document Authoring qualification lane handoff

The qualification lane started from exact base
`fe8beaa66ca963934fd027aa4501687d40117eb9`. Its six-package descriptors,
Source Dependencies v2 policy, hostile fixtures, derived release graph, package
qualification, registry-install exercise, new-only negative assertions, and
bootstrap candidate are now integrated. They become release evidence only when
the final physical package graph passes all required gates at one exact head.

`@agent-teams/document-authoring@0.0.0` is an approved bootstrap-only candidate
with reviewed package-tree and canonical SHA-512 SRI evidence in the bootstrap
catalog. That approval authorizes only the protected one-time namespace
bootstrap; it is neither registry evidence nor a supported release. Before a
dispatch, the exact protected-main head must reproduce the catalog evidence with
`node scripts/npm-package-bootstrap-local-evidence.mjs`. Publication must then
prove the immutable registry bytes, signature, source-bound provenance, tags,
and deprecation before the ordinary release can consume the namespace baseline.

## Delivery checklist

### 1. Foundation gate

- [ ] Bind the implementation change to one exact clean head and an approved
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

- [ ] Pack reviewed artifacts and perform clean exact-version npm and pnpm
  installs in disposable repositories with scripts/hooks disabled where the
  contract requires.
- [ ] Exercise public imports, CLI startup, portable authoring, adapter commands,
  and MCP transport from installed artifacts, not workspace source.
- [ ] Exercise path aliases, cross-package relatives, unexported subpaths,
  adapter discovery attempts, stale plans, changed preimages, crashes, version
  skew, incompatible journals, malicious document content, and resource limits.
- [ ] Retain supported Linux, macOS, and Windows evidence without claiming POSIX
  hard-power-loss durability on Windows.

### 6. Current-consumer migration preparation

- [ ] Inventory every current consumer at an exact commit, including legacy
  entrypoint/export use and every admitted persisted transaction generation.
- [ ] Prepare and review, but do not merge, explicit coordinated changes with
  intended exact coordinates, lockfile updates, new-only imports,
  managed-adapter placement, recovery instructions, and required-check plans.
- [ ] Bind an approved publication, consumer-rollout, and recovery plan to the
  exact packed artifacts and inventoried commits. Prove the prepared path needs
  no bridge, runtime autodetection, or automatic migration.

### 7. Exact-head integration checks

- [ ] Re-read HEAD and reject a base or ownership mismatch; inspect the complete
  diff and accepted-decision baseline promotion at that same head.
- [ ] Run `pnpm check:changed` while integrating, then `pnpm check:fast` before
  handoff and `pnpm verify` before the pull request. Record real outcomes rather
  than treating this phase-0 NOT RUN state as success.
- [ ] Obtain the required exact-head Linux, Windows, macOS, dependency, package,
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
