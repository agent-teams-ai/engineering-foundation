# Docs Portable Boundary Delivery and Evidence

Status: Repository Mutation extraction checkpoint implemented in a disposable
sandbox; independent integration review, API-authority registration, complete
qualification, Authoring extraction, publication, and consumer rollout remain pending.

The accepted target and sole manually maintained package DAG are in
[ADR-0043](../decisions/0043-new-only-portable-documentation-package-boundary.md).
This document tracks delivery dependencies and evidence; it does not redefine
the architecture or duplicate release order.

## Repository Mutation checkpoint evidence

Measured in the disposable documentation worktree on 2026-08-31:

| Evidence | State | Observation |
| --- | --- | --- |
| Exact base/HEAD | Pending integration | The extraction is an uncommitted linked-worktree patch; integration owns exact-head qualification |
| Current public manifests | Measured | The catalog projects five packages, including Repository Mutation and Docs Protocol Agent Teams; Authoring remains in Engineering Foundation |
| Git lock creation | Measured | Denied by the read-only linked-worktree Git directory; no retry and no history change |
| Build and focused tests | Measured | Pinned direct TypeScript build, lint, graph projections, manifests, and focused mutation tests pass in the disposable sandbox |
| Installs, packages, providers, network, or real projects | Not run | Prohibited for this extraction worker |
| `pnpm check:changed`, `pnpm check:fast`, `pnpm verify` | Blocked | The sandbox cannot open pnpm's database; direct pinned build and fast-check components pass, but no pnpm-gate claim is made |

This checkpoint evidence is not exact-head release proof. A checked item below
requires its own current, authoritative evidence rather than this prose.

## Delivery checklist

### 1. Foundation gate

- [ ] Bind the implementation change to one exact clean head and an approved
  ADR-0043 baseline promotion owned by integration.
- [ ] Inventory current exports, consumers, persisted transaction generations,
  and exact recovery artifacts before moving code or deleting an entrypoint.
- [ ] Apply the extraction admission invariant: prove repeated semantics with
  parity fixtures and delete superseded duplicates instead of wrapping them.
- [ ] Freeze package names, public subpaths, closed schemas, and ownership before
  package movement; reject consumer business catalogs or executable extensions.

### 2. Direct Agent Teams adapter split

- [ ] Move managed implementation, assets, and Qualified Cohort integration
  directly to `@agent-teams/docs-protocol-agent-teams` and
  `agent-teams-docs-managed`; leave none in portable Docs Protocol.
- [ ] Prove portable Docs Protocol and MCP have no static, type-only, dynamic,
  optional, subprocess, generated, or package-manifest path to the adapter.
- [ ] Add no alias, old root export, forwarding facade, bridge release, floating
  range, runtime detection, or dual managed implementation.

### 3. Mutation and authoring extraction

- [x] Extract the first coherent Repository Mutation leaf at the ADR-0043
  boundary, directly rewire current generic callers, and remove the Foundation
  mutation facade. Document Authoring remains in Foundation for the next lane.
- [ ] Extract Document Authoring with exact public API, package-content, and
  parity evidence.
- [ ] Preserve canonical Markdown/YAML, data-only profiles, disposable
  projections, exact-preimage application, bounded journals, and distinct
  Plans/Receipts/recovery handlers.
- [ ] Retain exact-build recovery for every admitted in-flight transaction;
  incompatible or ambiguous evidence must block mutation without rewriting it.

Repository Mutation protects the cooperative common lock and journal evidence.
A standalone portable caller does not classify an unaccompanied Foundation
orphan backup; full Foundation local-mode admission remains in Foundation's
composition wrapper. This ownership limit does not permit unknown common
journals to be ignored or treated as idle.

### 4. Derived package release qualification

- [ ] Make Source Dependencies v2 reject every failure class listed in ADR-0043,
  with positive and hostile fixtures and separate runtime/type-only cycle proof.
- [ ] Record qualification coverage for every public package and permitted edge;
  missing coverage must fail closed without inventing a source edge.
- [ ] At the exact release head, derive package publication order solely by
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
  all upstream exact artifacts and qualification evidence pass.
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
