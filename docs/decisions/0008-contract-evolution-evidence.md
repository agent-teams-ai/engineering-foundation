---
id: ADR-0008
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0008: Contract Evolution Evidence

Status: Accepted

Date: 2026-08-02

Decision owner: Product owner

## Context

Protobuf control APIs and JSON Schema event contracts have different evolution
rules. Treating generated output or an ad hoc compatibility command as authority
would make releases non-reproducible.

## Decision

Provide separate `contract.protobuf-evolution` and
`contract.json-schema-releases` capabilities. Normal foundation checks only read
strict, versioned evidence and never start Buf, a shell, or a network request.

Buf qualification runs in an explicit pinned CI boundary and records descriptor,
breaking-analysis, generator, and generated-output evidence. JSON Schema uses
strict draft 2020-12 validation, local-only references, immutable schema and
fixture corpus digests, and consumer conformance evidence. Released versions are
immutable. A Protobuf compatibility exception binds its exact breaking
fingerprint to an ADR present in the immutable accepted-decision baseline.

The normal capability proves internal consistency of committed evidence, not the
identity of the workflow that produced it. The consumer owns the required,
protected qualification workflow and evidence provenance. Foundation's initial
Buf process adapter verifies the pinned executable boundary; expanding it into a
complete producer-owned qualification workflow requires separate conformance
evidence and must not be inferred from a passing normal check.

## Consequences

Protobuf and JSON Schema remain separate public contract surfaces with separate
compatibility policy. Tool implementations are replaceable behind adapters, and
generated DTOs do not enter domain or application models.
