# Node 26 Default And Node 24 Compatibility

Status: the repository default is official Node 26.11.1 (`.node-version`).
Node 24.21.0 stays a compatibility lane. Managed generation2 consumer
qualification stays on its Node 24 tuple and is not migrated or claimed here.

The versioned [Docs Protocol current policy](../../architecture/foundation/docs-protocol-current-policy.json)
and its [v1 schema](../../architecture/contracts/docs-protocol-current-policy/v1.schema.json)
bind package engines, current schema generations, the portable qualification
entrypoint, and immutable historical schema digests. Its JSON Schema is
artifact-protected and does not add a JSON Schema family support claim.

## Runtime contract

All publishable Foundation packages use the exact Node engine range
`^24.18.0 || ^26.0.0`. `.node-version` is `26.11.1`; the compatibility matrix
runs the default lane on 26.11.1 and the compatibility lane on 24.21.0. The
frozen current-policy tuple (24.21.0 / 26.10.0) is historical data and is not
edited; `scripts/node-engine-compatibility.mjs` accepts the repository default
or an exact policy-qualified version. The compatibility
qualification installs packed packages into a new disposable consumer with
`engine-strict`, then verifies the installed manifests and
`@agent-teams/docs-protocol/qualification#runDocsProtocolQualification`.
It never reuses an install created by the other Node lane.
pnpm 11 enforces workspace install policy from `pnpm-workspace.yaml`:
`engineStrict` and `strictPeerDependencies` are both true. The compatibility
matrix runs disposable dependency fixtures that verify rejection of incompatible
engines and peers. A frozen
install can accept a lockfile created with peer enforcement disabled, so the
matrix also runs `pnpm peers check --lockfile-only` after its frozen install.
The fixture proves that this check rejects an incompatible locked peer graph.
Both required CI aggregates depend on the complete matrix.

The existing portable qualification runner remains the behavioral path for
info, find, preview, crash/recovery, doctor, receipt, parent creation, apply,
index projection, check and source immutability. It runs only against a new
disposable fixture. Agent launch, provisioning, terminal runtime, task
assignment and smoke flows are outside this qualification and are never run
against real projects.

## Legacy Node 24 exceptions

These stay on Node 24 on purpose because the managed generation2 contract
(`runtime.node` `>=24.18.0 <25`, frozen policy and packed `runtime-policy.v1.json`)
is still current and enforced:

- `scripts/pack-test.mjs` writes `.node-version` `24.21.0` into its managed
  generation2 consumer fixture and runs the adapter `check`/`plan`/`apply` CLI
  on the Node 24 given by `PACK_TEST_GENERATION2_NODE`
  (`scripts/generation2-node.mts` fails closed unless it is `>=24.18.0 <25`).
  `linux-package`, `windows-package` and `macos-package` install Node 24.21.0
  first, record its path, then select the Node 26.11.1 default for build and all
  other gates. Local runs under Node 26 must set the variable.
- `.github/workflows/m4-disposable-lifecycle.yml` runs entirely on Node 24.21.0
  (historical 0.2.x adapters).
- `.github/workflows/public-managed-registry-canary.yml` runs on Node 24.21.0.
- Managed test tools keep the 24.21.0 / 26.10.0 tuple; `ci.yml` retains both as
  pinned sources (`MANAGED_TEST_NODE24_SOURCE`, `MANAGED_TEST_NODE26_SOURCE`).
- Managed consumer fixtures with `.node-version` `24.18.0` in package tests.

Moving these to Node 26 needs a new qualified generation, not an edit here.

## Publication order

[ADR-0043](../decisions/0043-new-only-portable-documentation-package-boundary.md#package-release-concerns-and-consumer-rollout)
owns the package graph. The [manifest-derived release projection](../../scripts/publishable-packages.mjs)
computes its topological publication order at the exact release head. The
ordered publisher verifies each packed manifest and exact dependency timestamp
before moving to its dependents. No package or release is published by this
change.

## Consumer blockers

| Consumer | Exact blocker before adopting the Node 26-compatible release |
| --- | --- |
| agent-runtime | Existing Source Dependencies and managed-v3 qualification migration work; exact new five-coordinate Cohort and physical-root/recovery inventory remain pending. |
| agent-teams-orchestrator | Disposable parity fixture/closure/profile migration and managed five-coordinate qualification remain pending. |
| agent-teams-platform | Managed qualification migration remains pending; enforceable merge protection is unverified because the protection API is plan-restricted. |
| extension-foundation | Cohort/profile/fixture migration and its exact negative scenario retention remain pending. |
| docs-protocol-canary-20260817 | It is an explicitly test repository, but the stable9.1-to-target transition, Foundation gate and canary admission remain pending. |
| agent-teams-token | Stable8-to-target transition, capability inventory and enforceable merge protection remain pending. |
| get-modular | Portable profile v1 to v3 and Authoring profile v2 to v3 migration evidence remain pending; it has no managed Cohort blocker. |

Every managed consumer also retains the historical Cohort v1/v2 `runtime.node`
value `>=24.18.0 <25`. Those bytes remain authoritative for their generation.
A managed Node 26 cutover requires a new qualified Cohort generation and receipt,
not an edit to the preserved schemas. All consumers must recheck exact heads,
clean physical roots, journals, recovery generations, required checks and final
registry-resolved lockfiles after the coordinated package publication.
