# Node 24 Default And Node 26 Compatibility

Status: implemented as a compatibility policy and CI lane. Node 24 remains the
production/default runtime; owner-authorized Node 26 cutover is not claimed.

The versioned [Docs Protocol current policy](../../architecture/foundation/docs-protocol-current-policy.json)
and its [v1 schema](../../architecture/contracts/docs-protocol-current-policy/v1.schema.json)
bind package engines, current schema generations, the portable qualification
entrypoint, and immutable historical schema digests. Its JSON Schema is
artifact-protected and does not add a JSON Schema family support claim.

## Runtime contract

All publishable Foundation packages use the exact Node engine range
`^24.18.0 || ^26.0.0`. `.node-version` stays at `24.21.0`. The compatibility
qualification installs packed packages into a new disposable consumer with
`engine-strict`, then verifies the installed manifests and
`@agent-teams/docs-protocol/qualification#runDocsProtocolQualification`.
It never reuses an install created by the other Node lane.

The existing portable qualification runner remains the behavioral path for
info, find, preview, crash/recovery, doctor, receipt, parent creation, apply,
index projection, check and source immutability. It runs only against a new
disposable fixture. Agent launch, provisioning, terminal runtime, task
assignment and smoke flows are outside this qualification and are never run
against real projects.

## Publication order

The manifest-derived topological order is exact:

1. `@agent-teams/repository-mutation`
2. `@agent-teams/document-authoring`
3. `@agent-teams/docs-protocol`
4. `@agent-teams/docs-protocol-agent-teams`
5. `@agent-teams/docs-protocol-mcp`
6. `@agent-teams/engineering-foundation`

Items 4 and 5 are independent after Docs Protocol and are ordered
lexicographically by the release projection. The ordered publisher must verify
each packed manifest and exact dependency timestamp before moving to its
dependents. No package or release is published by this change.

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
