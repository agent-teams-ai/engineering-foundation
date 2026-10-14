---
id: ADR-0059
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0059: Node 26 Current Policy Coherent Behavior Unit

Status: Accepted for the repository architecture coordinator within the
continuing Product owner Node 26 migration scope after Root scope/hash checks
and independent decision review. Independent whole-code review and required CI
remain before merge.

Date: 2026-10-14

Decision owner: Product owner; repository architecture coordinator records the
bounded decision.

## Context

Foundation PR #391 is exactly base
`389706989c27f54daea9c23f59cc3647efbd88e7` to head
`7673721354767420d68950aef2359fd45d3837ac`. The supplied realscopeaudit A1 record
`ae4687aeb6e9b24e96b11725664aa44debf213f657ee7dbaf4e7cd3f6573c39c`
confirmed that the behavior ADR was missing and that every new behavior in the
unit is necessary for the current Node 26 policy and its applicable immutable
Node 24 Cohort2 path. Restoration dependency wiring is non-behavioral.

The exact diff is 70 files, 6019 additions and 494 deletions: 2681
production-source changed lines, 1219 schema/policy data, 2189
tests/fixtures, and 424 metadata/docs. The repository coordinator justifies exceeding the approximate 2000 changed-LOC
review target with one minimum coherent PR of approximately 2681 source-review
lines because splitting one Node 26 policy/schema/runtime/qualifier/canary
invariant would create transient incompatible halves. This is a bounded
coordinator review-budget justification, not a hard line cap.

## Decision

1. Accept this exact 70-file coherent unit for owner-authorized Node 26
   migration only. Nothing outside that scope is authorized; a concrete
   independent unit outside it must be reported by exact file rather than
   enforced through a mandatory split ritual.
2. Current policy remains `3.0.0`: Node `26.11.1` is the production default
   and Node `24.21.0` is the compatibility lane. A Node 24 lane is not
   permission to leave the default at Node 24.
3. The exact current inputs are
   `architecture/foundation/docs-protocol-current-policy-v3.json` and
   `architecture/contracts/docs-protocol-current-policy/v3.schema.json`;
   the packed projection remains
   `packages/docs-protocol-agent-teams/assets/runtime-policy.v1.json`.
4. Profile 4, Cohort 3, managed state 3, and
   `docs-protocol-cohort-v3-qualification-receipt/v1` remain a strict
   unselected candidate-qualification path. Candidate qualification is not
   lifecycle promotion; it creates no automatic central admission.
5. The five coordinates are Repository Mutation, Document Authoring, Docs
   Protocol, Docs Protocol Agent Teams, and Engineering Foundation. The three
   managed roots are Docs Protocol, Docs Protocol Agent Teams, and Engineering
   Foundation; ADR-0043's DAG and all model/adapter/module-owner/source/
   coverage/shard/Windows registrations remain exact, with no weaker gates,
   exclusions, or waivers.
6. Cohort v3 qualification requires actual observed Node `26.11.1`, pnpm
   `11.20.0`, Linux, x64. Public managed registry canary receipt v2 is
   read-only evidence format; only a real E2E run can prove E2E. A nominal
   schema, synthetic record, fixture, or import is not release or E2E proof.

Historical v1/v2 policy, receipts, and controllers remain byte-immutable.
Existing unselected schema families are retained, but ADR-0056 remains Proposed
and this decision does not broadly adopt it. ADR-0058 remains byte-immutable,
and its accepted fingerprints
`sha256:d9af150a7c71fb7fa0172f1d51aa77d5eb8509977a90548b743a77a1c29afaea`
and
`sha256:b0bc159c7a8385393399623aaa98d80200bf93755030886b5b0fb4fddb18f79e`
are unchanged. This docs-only acceptance changes no public API fingerprint or
artifact inventory and infers no prior approval.

## Exclusions and release boundary

Exclude Bridge B, a new attestation service, a new installation-restoration
framework, receipt v4, a second transaction engine, a generic union or schema
family mechanism, a second SPI/runtime claim, and automatic central admission.
The package boundary is only `@agent-teams/docs-protocol-agent-teams` `0.5.0`
through the existing Changesets Trusted Publishing path, with exact registry
SRI/provenance and strict Node 24 plus Node 26 verification. Real Canary 3.0
Node 26 E2E remains required later.

## Review, rollback, and evidence

Root retains independent review of the exact whole code and the full 35-green
required CI. This acceptance is decision authority, not a claim that CI,
release, publication, artifact qualification, Canary, or E2E already occurred.
No code change is authorized merely to make governance pass. Future deliveries
retain an approximately 2000 changed-LOC review budget as a target, not a hard
cap; when one invariant cannot be safely split, the coordinator records the
reason and chooses the minimum coherent PR within the authorized Node 26 scope.

Before adoption, revert the coherent Node 26 current behavior unit and its
registrations as one unit without rewriting accepted ADR-0058 or historical
byte contracts; retain recognized old formats and controllers. After
publication or consumer adoption, do not rewrite package or retained receipts:
issue a fix-forward release or use the existing qualified recorded-origin
rollback after fresh authority. No new supervisor or restore engine is created.
