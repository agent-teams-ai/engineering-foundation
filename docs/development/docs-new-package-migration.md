# New package migration preparation

Status: draft preparation against the exact commits in the
[consumer inventory](docs-portable-consumer-inventory.md). No consumer was
executed or migrated. Final package coordinates, reviewed artifact identities,
native platform evidence and consumer recovery admission remain required.

## Shared preparation contract

Each packet below needs its own reviewed diff and disposable qualification.
Package names and versions come from the final Changesets/manifest projection;
this document is not a second version catalog or publication graph. Before
publication, bind each packet to that projection, the source SHA, dependency
lock digest and reviewed packed artifacts. After publication, bind actual SRI,
provenance and the registry-resolved lockfile before cutover.

The six managed roots keep exact development dependencies on Foundation and
Docs Protocol and add Docs Protocol Agent Teams. Mutation and Authoring remain
the exact transitive coordinates in the qualified five-coordinate Cohort unless
a consumer has an independently justified direct API dependency. Get-modular
keeps portable ownership and does not acquire managed integration.

For the six managed repositories, explicitly prepare integration profile v3,
Cohort v2, managed state v2 and qualification receipt v3 through the existing
[managed lifecycle](../architecture/managed-docs-consumer-integration.md).
The historical qualification scenario contract is a separate input; a receipt
version does not authorize renaming its discriminator. Preserve immutable source
records and produce the target records using the reviewed target tools.

Prepare the portable profile separately from managed records. Its current
v1/v2 bytes do not select the new-only reader. The minimal target v3 profile
declares `agentWorkflow.adoption: portable-v1`, Authoring profile schema 3 and
`foundation-profile-v3-strict-merge`. It retains the historical blocker policy:
types `open-decision`, target statuses `deferred` and `open`, incompatible
subject statuses `accepted` and `active`. Preserve every actual profile path,
Skill path, validator identifier, owner and authored document. A consumer needing
different vocabulary explicitly selects v4 and supplies `relations.blockers`;
qualify that choice and any managed asset projection separately. The package
upgrade does not silently activate a different architecture or blocker policy.

Get-modular additionally upgrades its Authoring profile v2 to v3. Retain its
explicit `allowedOwnerIds`; v3 does not require inventing named owner sets.
Verify canonical document bytes, metadata merge, missing-parent behavior and
owner rejection against the old and target artifacts in a disposable fixture.

Portable `info/find/new/check/doctor/recover` commands keep the portable
executable. Managed lifecycle commands select `agent-teams-docs-managed`.
Profile v3 qualification comes from the existing trusted registry/canary lane;
the consumer CLI intentionally refuses to mint that receipt. Its v3 API validates
explicit authority, observed evidence and lockfile bytes, rather than accepting
a consumer root alone. Wire that proof into the required consumer status and
retain independent portable authoring scenarios. Do not route by installed package count,
optional exports or fallback imports. Where automation approves a preview,
carry its reviewed digest into the target apply request and prove stale-digest
refusal before any write.

## Per-consumer packets

| Consumer | Concrete migration work | Required acceptance evidence |
| --- | --- | --- |
| agent-runtime | Replace both private Source Dependencies imports in `scripts/architecture/source-dependency-adapter-boundaries.test.mjs` with a supported installed-CLI fixture; preserve every existing positive and forbidden-import assertion. Replace the optional v2 qualification lookup/fallback in `scripts/docs/docs-protocol-adoption.test.mjs` with explicit managed v3 authority/receipt validation from the trusted lane. Update exact pin/profile/receipt assertions and stage the common profile migration. | Blocking `check` and docs status at the migration SHA; the negative suite still executes once; v1 source scope remains the eight explicit roots; all five authorable types and actual validator IDs remain covered. |
| agent-teams-orchestrator | Keep supported Foundation/scaffolding imports and the root transaction-mode inspection API. Update disposable parity fixtures, copied package closure and profile authority in `scripts/docs/docs-protocol-parity.test.mjs`; retain the portable qualification runner for portable scenarios and add explicit managed five-coordinate qualification. | Blocking `architecture`, dependency review and docs status; all six existing authoring scenarios, scaffold/transaction barriers, exact existing validator IDs and consumer-owned prose/diagram gates. |
| agent-teams-platform | Replace the old `agent-teams-docs qualify` invocation in `docs:qualification` with the explicit profile-v3 authority/receipt check backed by the trusted registry/canary lane; update adoption assertions, installed closure and the common profile/managed records. Keep the supported scaffolding API and both architecture validators. | Execute the full Foundation path and qualification scenarios; establish enforceable merge protection. Current ruleset/protection API access returns a plan feature restriction, so protection is unverified. |
| extension-foundation | Update generation and Cohort assertions in `tests/docs-protocol-qualification.test.mjs`, installed fixtures in `tests/document-authoring.test.mjs`, and the common profile/managed records. Keep supported scaffolding, `docsFind` and package-policy APIs. | Blocking `check` and docs status; ADR, architecture and open-decision scenarios retain exact paths and manual reachability; negative source/package-policy checks retain their actual v1 universe. |
| docs-protocol-canary-20260817 | Stage the explicit stable9.1-to-target managed transition and portable profile migration. Add the applicable full Foundation gate and its fixture if architecture checking is being adopted; the current root has no Foundation capability configuration. | Existing docs status plus the accepted additional required check. Use this explicitly test repository for a qualified canary only after its source state and target Cohort admit that route. |
| agent-teams-token | Stage the explicit stable8-to-target transition and profile migration. Inventory and configure the applicable Foundation capabilities rather than treating installed presets or `docs:check` as source graph coverage. | Full applicable checks and their negative fixtures; establish enforceable merge protection, currently unverified due to the API plan restriction. |
| get-modular | Keep portable packages only; migrate Docs Protocol profile v1 and Authoring profile v2 as described above. Preserve both authorable types, explicit owner lists and Foundation's selected source-dependency/documentation/ADR/workflow/declaration capabilities, including the `packages/core/src` v1 source scope. | Existing Linux, macOS and Windows required `check` contexts; portable positive/negative profile and CLI results; Windows unsupported mutation is a refusal outcome, not successful apply qualification. |

The five observed consumers enabling Source Dependencies use v1, including
get-modular at `9239f9caec280a9c08695ad8d8d6f7f9366568c1`. Preserve their
selected `governedRoots` during this package migration. A forbidden import inside
that scope must fail. A repository-wide v2 claim requires a separately explicit
selected-package policy and unknown-source/package counterexamples. Do not
silently activate Source Dependencies in the other two repositories.

## Admission and rollback

Retain published artifact generations separately: Foundation 0.21.0 / Docs 0.4.1,
the split release from `cd14bd34590f0abdb668015dd7cbe7646ac4164e`, and the
patch release from `c1ef6cb11867a7504ec03706e10e19761c5271fc`. In particular,
Agent Teams 0.1.0 and 0.1.1 export different upgrade-execution schema bytes under
the same v1 ID. Resolve historical validation and recovery by the exact archived
owner/build, never by schema ID alone or by rewriting a retained record. These
archives do not prove that a consumer has no other recovery generation.

Every packet is pending its actual physical-root and transaction-state inventory.
Read-only committed files do not prove that journals or in-flight operations are
absent. Preserve the old exact owner and kernel artifacts, receipt/build identity
and bytes for each supported recovery route. Unknown or foreign evidence blocks
that consumer's cutover; it does not authorize clearing a journal or rebuilding
the old package under its existing version.

Before an authorized cutover, prove clean source HEAD, the explicit qualified
`upgrade_from` route, exact target artifacts, transaction-idle state and the
consumer's blocking checks. Qualification fixtures may run only in new sandbox
projects or explicitly test projects. Real runtime/agent commands still require
the user's fresh authorization for that real project.

Before publication, revert an unpublished source/consumer preparation diff.
After publication, package bytes are immutable; correct them with a new release.
After cutover, use only the qualified reverse operation/`rollback_to` with its
exact source installation and preserved transaction barrier. A lone package
downgrade or a handwritten replacement of managed evidence is not rollback.

Prepared files and old/current artifact comparisons are not admission evidence
until independently reviewed. Record per consumer: source SHA, intended target
projection, reviewed archive digests, source/target generations, recovery route,
actual commands and required statuses, observed failures/skips, and rollback
proof. Then add published integrity and exact migration-head CI results.
