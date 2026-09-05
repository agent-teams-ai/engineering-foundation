---
id: ADR-0049
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0049: Truthful Authoring Generic Returns

Status: Accepted

Date: 2026-09-05

Decision owner: Product owner

## Context

Document Authoring's generic runtime produces both admitted Plan and Receipt
generations. Its initial declarations asserted v1 and hid v2 results from
TypeScript callers. The request also accepts the closed optional `parentPolicy`
that the planner already implements. The initial `0.0.0` API reference is
historical bootstrap evidence, not a supported release; it remains unchanged.

## Decision

Use the existing `PlanDocumentationDocumentRequestContract`, `DocumentPlanContract`
and `DocumentReceiptContract` in the generic public facade. Preserve the v1
`DocumentPlan` and `DocumentReceipt` names, explicit V1 aliases, and existing
explicit V2 planning and apply entrypoints. Both recovery entrypoints return the
union because the recovery request cannot select the persisted generation.

| Public entrypoint | Input authority | Fulfilled result |
| --- | --- | --- |
| `planDocumentationDocument` | Generic request and validated profile, including closed `parentPolicy` | `DocumentPlanContract` |
| `planDocumentationDocumentV2` | Required materialization policy and compatible profile | `DocumentPlanV2` |
| `applyDocumentationPlan` | Unknown Plan validated before writer execution | `DocumentReceiptContract` |
| `applyDocumentationPlanV2` | Existing typed v2 Plan request | `DocumentReceiptV2` |
| `recoverDocumentationTransaction` | Supported persisted evidence | `DocumentReceiptContract` |
| `recoverDocumentationTransactionV2` | The same persisted-evidence authority | `DocumentReceiptContract` |

Callers must narrow `schemaVersion` or `protocolVersion` before accessing
generation-specific fields. A v1-shaped request can carry extra properties and
the profile contributes to generation selection, so a v1-only overload would
remain unsound. Explicit V2 apply keeps its existing typed contract; its result
guard does not create a new pre-write guarantee for untyped invalid callers.

Admit this TypeScript source change with a minor Authoring Changeset under the
existing pre-1.0 policy. Approve only fingerprint
`sha256:7e5eb1fb1386edb0b7bcf1de3bc63c95ba51094a069a0edcf648c8c284795558`.
It covers three generic signature corrections and the textual inline-import to
named-union change in V2 recovery, whose return already was a union. No public
items or export paths are added or removed. A different later fingerprint needs
its own reviewed decision evidence. API baseline promotion remains release-owned.

## Runtime, wire and recovery limits

This declaration correction changes no runtime, schema, journal, digest or
recovery behavior. It does not ratify existing same-ID schema drift or incomplete
artifact binding. Those are separate first-supported-release blockers requiring
current owner-qualified contracts and preserved historical schema bytes.

Recovery admission requires the exact recorded owner and kernel package names,
versions and build identities. This type correction does not establish that
proof: the candidate Authoring journal still lacks a separate Mutation kernel
coordinate. Missing coordinates must never be filled into historical evidence.
Rebuilding the same package version does not reproduce recovery authority.

[ADR-0024](0024-versioned-document-transaction-recovery.md) and
[ADR-0043](0043-new-only-portable-documentation-package-boundary.md) retain their
historical recognition, barrier and exact-artifact requirements. No reader,
handler or support window is retired here. Retirement still requires the
specified inventory, retired writers, expired declared support window,
recovery evidence and a new decision. Managed generations and the five-coordinate
contract in [ADR-0045](0045-five-coordinate-qualified-docs-cohort.md) are unchanged.

## Validation and migration

The module's installed public-API tests exercise inferred generic returns,
negative field access, both Plan/Receipt generations, frozen bytes, actual crash
checkpoints, replay and both recovery names. Their inert source templates are
materialized with unchanged bytes and original extensions only in disposable
installed consumers. Test-only dynamic permissions name the exact fixtures.

For v1 receipts, use `commit.atomicity`; for v2, use `commit.fileAtomicity` and
`directoryMaterialization`. A generic Plan's `parentMaterialization` likewise
requires narrowing to v2. Do not restore v1 assertions to silence type errors.

Independent review and required integrated gates remain necessary for the PR.
Passing these type tests is not packed, registry, cross-platform or consumer
qualification, and does not authorize publication or consumer cutover. Historical
failed attempts and later bounded reruns remain distinct evidence.

An unpublished correction can be reverted as its owned unit, but restoring the
unsound declaration must block first-supported admission until corrected.
Published artifacts and persisted journals remain immutable. Later corrections
require a new exact release; managed rollback requires a qualified `rollback_to`
and transaction-barrier inspection rather than a single package downgrade.
