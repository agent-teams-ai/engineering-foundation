---
id: ADR-0061
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0061: Node 26 Qualified Consumer Upgrade

Status: Accepted by the repository architecture coordinator within the
continuing Product owner Node 26 migration authorization at source
`bcfc3e5f2f63cf0093f0d69766f648e409449950`. Root accepts this new decision
within that owner-approved scope; independent final technical review and
required CI remain before merge. This decision records one bounded route and
does not claim that migration, publication, or final E2E is complete.

Date: 2026-10-14

Decision owner: Product owner; the repository architecture coordinator records
this bounded decision.

## Supported transition

Support exactly one ordinary consumer transition:
Profile 3 / Cohort 2 / managed state 2 / qualification receipt 3 to Profile 4 /
Cohort 3 / managed state 3 /
`docs-protocol-cohort-v3-qualification-receipt/v1` receipt 1. The source remains
the protected Canary consumer with the retained exact Node 24.18.0 source pin;
that pin satisfies the existing Cohort 2 `>=24.18.0 <25` contract. The target is the policy
3.0.0 Node 26.11.1 production default with pnpm 11.20.0 on Linux x64. Profile,
cohort, state, receipt and policy versions remain distinct nominal identities.

The existing Profile 1 / Cohort 1, Profile 1 to Profile 3 / Cohort 2, Profile 3
same-generation, Profile 3 to Cohort 2, and bounded 1-to-2 restoration routes
remain unchanged and retain their rejecting behavior. This proposal adds no
Bridge B, compatibility writer, generic migration engine, new transaction
engine, attestation service, installation/restoration framework, universal
manager, package, composition root or Get Modular graph node.

## Owner and dependency direction

The existing DocsAgent `consumer-integration` feature owns the domain types,
upgrade use case, lifecycle policy and deterministic projection contracts.
Its adapters implement the authority reader, file projectors, source proof and
Node sandbox ports. The current Host composition wires those fixed dependencies
to the existing known-file transaction, custody and CLI. Application policy
depends on ports in its own vocabulary; adapters translate registry and
filesystem data. These are fixed SDK helpers for real consumers, not dynamic
providers. Foundation has FMS adoption but no Get Modular construction
profile or pin, so this change creates no Get Modular adoption claim.

## Public API evolution

The source/API change was read before this decision. In
`packages/docs-protocol-agent-teams/src/consumer-integration/adapters/consumer-upgrade-file-projectors.ts`,
both exported cohort inputs use the public inline union
`QualifiedDocsCohortBindingV2 | ManagedSuccessorProfile["cohort"] | UnselectedCohortV3`
rather than a private alias:

```ts
export function projectPnpmWorkspaceCohortExclusionsV2(input: {
  readonly bytes: Uint8Array;
  readonly cohort: QualifiedDocsCohortBindingV2 | ManagedSuccessorProfile["cohort"] | UnselectedCohortV3;
}): Uint8Array;

export function projectPnpmWorkspaceMigrationExclusionsV2(input: {
  readonly bytes: Uint8Array;
  readonly source: QualifiedDocsCohortBindingV2 | ManagedSuccessorProfile["cohort"] | UnselectedCohortV3;
  readonly target: QualifiedDocsCohortBindingV2 | ManagedSuccessorProfile["cohort"] | UnselectedCohortV3;
}): Uint8Array;
```

The transition extends the existing cohort, planning and upgrade contracts with
explicit generation-3 and selected Profile4 values. Inlining the public members
makes the extractor resolve the exact public
contract while preserving the existing cohort semantics and rejection
behavior. The actual pinned API check now extracts successfully and reports
one breaking fingerprint for
`@agent-teams/docs-protocol-agent-teams`:

`sha256:8107d4aba03496fcc0a495c308c155baa71b30df94c44e8a9d5c45194cbb9148`

Approve only that exact fingerprint through the existing compatibility policy,
referencing `ADR-0061`, while retaining the existing ADR-0058 and ADR-0060
approvals unchanged. The released `0.4.0` typed and artifact baselines,
package versions, manifests and generated baselines remain unchanged; this
decision performs no baseline promotion or release action.

## Authorizing evidence and lifecycle boundary

Generation 3 reads the same protected `agent-teams-ai/.github` registry at one
exact current revision and reuses the Cohort3 authority projection. Admission
requires one canonical Cohort3 record, its immutable record digest, the global
event-chain digest, one immutable `QUALIFIED` event, and a current lifecycle
that is either `RECOMMENDED` or `CANARY` with complete signed canary evidence
for this exact repository. `QUALIFIED` publication alone is not consumer
selection. The eligibility instant must have passed. The five exact package
coordinates, canonical dependency edges, policy 3.0.0 source digest, Node
26.11.1 / pnpm 11.20.0 / Linux / x64 tuple and immutable five-package,
three-root runtime closure must all match.

The retained policy 3 and its schemas remain byte-immutable and continue to say
`managedCandidate.selected: false` / `candidate-unqualified`. That artifact is
candidate policy evidence, not a post-lifecycle registry record. This route does
not relabel it. Selection is represented separately by the protected registry
lifecycle plus an in-memory selected-state wrapper. If the organization instead
requires the current policy artifact itself to assert selected/qualified, the
exact contradiction is policy schema v3 `managedCandidate.selected` and status
constants and the packed loader's selected rejection; that requirement needs a
successor current policy and schema version rather than a cast or edit to
policy 3.

## Selected state construction

After the lifecycle boundary passes, construct one selected successor value that
contains the closed Profile4 data and separate selection evidence. Persist only
the Profile4/Cohort3 binding allowed by the existing schemas: profile schema 4,
cohort generation 3, managed state 3, qualification receipt 1 and policy version
3.0.0. Lifecycle state and canary repository IDs remain authority evidence and
are not smuggled into the profile binding. The construction preserves the
consumer repository identity and existing governed roots and uses the Cohort3
five-package coordinates without inferring generation from installed packages.

## Physical preconditions and rollback

Before repository writes, require an idle Foundation transaction, one exact
clean committed source HEAD, a current Profile3/Cohort2 source plan, exact
source file preimages, an exact Node24 source pin, the three direct package
roots and two transitive five-package coordinates, and one immutable
three-root runtime closure. The migration-source read may observe a Node24
source from the Node26 migration host, but ordinary Profile3 check/plan/apply
remain Node24-only. Target preparation occurs in a disposable copy with the
existing source snapshot checks, managed asset preimages, strict file
projectors, pnpm closure verification and target CLI convergence. The committed
transaction projects Profile4, state3, the three root pins, the five-package
workspace exclusions and `.node-version` 26.11.1 in one known-file plan.

Authority is reread at the same protected revision after staging and before the
transaction. Pre-transaction rejection performs no consumer writes. Known-file
preconditions reject drift atomically. If target activation fails after apply,
reverse exactly the receipt-owned replacements and verify the exact retained
Profile3/Cohort2 source snapshot and managed preimages. A partial receipt is not
reversed blindly. No new retained restoration proof or old-format rewrite is
created.

## Evidence boundary

The source/API review and pinned extraction above are implementation evidence.
The actual Root Node 26.11.1 build passed after the tiny public-signature fix in `pnpm-manifest-adapter-v2.ts`, and the
pinned API check extracted successfully before rejecting only the fingerprint
recorded above. Those observations do not convert this decision into a
migration, publication, or E2E claim.

Disposable TEST fixtures may prove the public CLI/use case transition,
lifecycle and repository rejection before writes, wrong exact runtime tuple,
authority drift, source preimage drift, retained source history and atomic
rollback. They do not prove signed public-archive qualification, registry
lifecycle transition, real consumer adoption, publication or final Node26 E2E.
Those remain Root delivery steps and require independent final technical
review.

The existing source Profile3 / Cohort2 / state2 with Node `>=24.18.0 <25`
was verified directly in real Canary main blobs
`df3b901256894c452a48299d229d757ada4f2fdd` and
`1b797b03d6e146a14c88750a7f5805756cea6beb`. Those blobs verify only the
source binding. Profile4 / Cohort3 / state3 on Node 26.11.1 is the target
of this decision; real consumer migration, publication and final E2E remain
pending.
