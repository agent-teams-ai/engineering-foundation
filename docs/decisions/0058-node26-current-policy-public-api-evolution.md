---
id: ADR-0058
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0058: Node 26 Current Policy Public API Evolution

Status: Accepted for owner-authorized bounded delivery; independent technical
review and complete required CI remain before merge.

Date: 2026-10-12

Decision owner: Product owner

## Context

The exact `c30c7c19cd9c0a6f97c349db5acb86c9166e9537` composite already contains
the requested Node 26 current-policy source changes. API Extractor 7.58.12
compares package version `0.4.0` with the current `ConsumerIntegrationDesiredState`
alias as `ConsumerIntegrationDesiredStateV1 | ConsumerIntegrationDesiredStateV3`
before and that union plus `ManagedSuccessorProfile` after. The observation
reports no removed items or kind changes, and both qualification entry
signatures are unchanged.

Two intentional non-type schema inventory changes also exist:
`schemas/managed-runtime-policy/v1.schema.json` changes current policy `2.0.0`
with Node 24 as production default to policy `3.0.0` with Node 26.11.1 as
production default, while Node 24 remains the compatibility lane; and
`schemas/qualified-docs-cohort/v3.schema.json` changes the current-policy
version constant from `2.0.0` to `3.0.0`. Historical schema bytes, receipt
bytes, and retained generations remain immutable.

The exact composite required-gate comparison reports only these two breaking
fingerprints:
`sha256:d9af150a7c71fb7fa0172f1d51aa77d5eb8509977a90548b743a77a1c29afaea`
for the exact exported schema inventory change containing the two
current-policy schema evolutions, and
`sha256:b0bc159c7a8385393399623aaa98d80200bf93755030886b5b0fb4fddb18f79e`
for the typed `ConsumerIntegrationDesiredState` widening. No fingerprint
is approved by inference.

## Decision

Approve only the two fingerprints above for
`@agent-teams/docs-protocol-agent-teams`, each referencing ADR-0058. Preserve
every prior approval and accepted digest. The existing governance declaration
already owns the ADR root/index and accepted-baseline path, so only the index
and one immutable entry are needed for ADR resolution. Release-owned typed and
artifact public API baselines remain unchanged.

The typed change widens `ConsumerIntegrationDesiredState` from V1/V3 to
V1/V3/`ManagedSuccessorProfile`. Existing V1 and V3 values remain valid.
Consumers that exhaustively switch on the alias or assign every value to a
two-variant target must narrow `schemaVersion` and handle schema version 4 for
the closed unselected successor profile. `ManagedSuccessorProfile` remains
unselected and grants no managed lifecycle activation.

The exported schemas remain artifact-protected. Consumers selecting current
policy must use policy `3.0.0`, Node 26.11.1 as the authorized production
default, Node 24.21.0 as the compatibility lane, and the matching Cohort v3
policy version constant. Existing historical policy, cohort, receipt, and
generation bytes must not be rewritten to present this evolution as retroactive.

This accepted ADR authorizes only owner-authorized delivery of these exact
changes and their independent technical review before merge. It is not
evidence that release, publication, E2E, packed-consumer qualification, or a
real-consumer canary happened.

## Migration and evidence

The existing minor Changeset `docs-node26-policy-current.md` carries this 0.x
migration and is expected to produce `0.5.0` from `0.4.0`. The existing
[Node 26 migration guide](../development/node-26-compatibility.md) remains the
consumer migration source. Its real-consumer `docs-protocol-canary-20260817`
transition and canary admission remain pending; this ADR records no fabricated
completion.

After the root verifies this proposal's hash, scope and applicability on the
exact composite, only the failed required gate is rerun there. The supplied
root observations for build, full types, lint, eleven focused checks, feature
modules, and source dependencies are retained facts from the pre-proposal
composite, not new post-patch claims. Independent review, the complete required
CI matrix, release promotion, physical release evidence, and consumer migration
remain separate gates after merge review.

No universal union-widening mechanism, schema compatibility mechanism, bulk
promotion, baseline overwrite, or release authority is adopted.

## Boundaries and rollback

The change is limited to the two exact public compatibility approvals, this
ADR and its required governance index/baseline metadata, and a non-behavioral
source-spacing correction that restores the existing complexity suppression
waiver from physical line 55 to registered line 54. The waiver, directive,
rules, owner, reason, creation date, expiry date, and decision reference remain
unchanged.

Before merge approval, revert this proposal as one unit if either fingerprint
does not match the exact composite or independent review rejects the bounded
migration. Published or historical artifacts remain immutable; correction after
release requires a new release and cannot edit retained evidence.
