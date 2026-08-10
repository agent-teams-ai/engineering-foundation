---
id: ADR-0021
status: accepted
supersedes:
  - ADR-0020
superseded_by: []
---

# ADR-0021: Consumer-Owned State Model Axis Topology

Status: Accepted

Date: 2026-08-10

Decision owner: Product owner

## Context

ADR-0020 introduced the optional XState-shaped evidence profile as static
connectivity. Its requirement for at least two axis identifiers implied that
Foundation could determine how many independent behavioral dimensions a
consumer model must expose. Foundation does not import or execute that model,
so it cannot substantiate the identifiers' meaning, independence, or parity
with behavioral evidence. The cardinality rule rejected valid single-axis
models while accepting any two schema-valid labels. For the same reason,
Foundation has no evidence for a minimum of one and must not force an
axis-free consumer to invent its first label.

ADR-0020 is immutable historical evidence. This successor preserves its trust,
process, and ownership boundaries while correcting the unsupported topology
claim.

## Decision

1. Retain the opt-in `quality.executable-specifications` capability and its
   strict, local-only, process-free connectivity inspection.
2. Retain the optional v1 `stateModel.kind: xstate` profile. It remains a
   structural evidence shape and does not add an XState runtime dependency.
3. Require an explicit array containing zero or more unique, schema-valid axis
   identifiers. Treat every identifier as opaque consumer-owned connectivity
   data.
4. Foundation does not infer or claim axis meaning, independence, completeness,
   reachability, or parity with the model, adapter, traces, or diagram.
5. Consumer gates remain authoritative for all state-model semantics and must
   prove any stronger domain-specific axis or parity requirements.
6. Other state-model formalisms still require a separately versioned and
   qualified contract extension rather than reinterpretation of v1.

## Consequences

- Axis-free and single-axis XState evidence can use the structural profile
  without inventing labels Foundation cannot substantiate.
- Existing multi-axis consumers remain compatible and retain their stronger
  executable parity gates.
- Foundation validates the presence and wiring it can observe without claiming
  behavioral assurance it cannot execute.
- The catalog schema change is backward-compatible but changes schema meaning,
  so it ships as a pre-1.0 package minor; published older artifacts remain
  immutable.

## Rejected alternatives

- Keep the two-axis minimum as a proxy for model rigor Foundation cannot test.
- Accept arbitrary state-model formalisms under the XState-shaped v1 contract.
- Run consumer models or scripts from the shared Foundation process.
