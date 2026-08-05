---
id: ADR-0015
status: superseded
supersedes: []
superseded_by:
  - ADR-0016
---

# ADR-0015: Qualified Buf FILE Evidence

Status: Accepted

Date: 2026-08-05

Decision owner: Product owner

## Context

ADR-0008 requires pinned Buf qualification outside normal Foundation checks, but
its initial evidence model could not prove that a committed breaking result came
from the configured `FILE` policy or from the declared baseline and candidate.
Self-consistent hashes alone also cannot prove producer provenance.

Changing accepted ADR-0008 would destroy historical evidence. This decision
supplements it with an executable producer boundary and a closed qualification
envelope.

## Decision

`contract.protobuf-evolution` configuration schema v2 separates the current
contract declaration from the Buf breaking result. The result is supplied by a
versioned qualification envelope produced by the explicit
`protobuf-qualify-breaking` command.

The producer verifies the exact pinned Buf version and executes `buf build` and
`buf breaking` with the declared module, configuration, released descriptor and
candidate descriptor. The Buf configuration must declare exactly
`breaking.use: [FILE]`; exclusions and weaker policies are rejected.

The envelope binds:

- schema, producer and policy versions;
- contract ID and exact Buf version;
- module, configuration, released descriptor and evidence paths;
- configuration, released descriptor and candidate descriptor SHA-256 digests;
- a canonical digest of the complete invocation semantics;
- normalized, deterministically ordered findings and their digest;
- normalized raw output and complete envelope digests.

Write mode atomically creates or replaces canonical evidence. Check mode always
reruns Buf and byte-compares the newly produced canonical envelope with the
committed file. Missing, stale, mismatched, non-canonical and fabricated evidence
therefore fails the protected qualification workflow.

Normal Foundation checks remain read-only and process-free. They validate the
closed envelope schema, actual configuration and released descriptor bytes,
all declared bindings and all recomputable digests. A breaking finding still
requires an exact accepted-ADR fingerprint under ADR-0008.

Hashes prove binding and integrity, not the identity of the process that created
them. Producer provenance comes from rerunning the pinned command in protected
CI with reviewed workflow, tool pins and source. The normal check must not claim
equivalent provenance. Configuration schema v1 is retained as an immutable
published schema but is rejected by the executable capability because it cannot
provide these guarantees.

## Consequences

Compatible and breaking results are reproducible against exact bytes and exact
`FILE` semantics. Consumers gain one reusable producer instead of reimplementing
Buf parsing and evidence canonicalization. The normal capability still has no
shell, process or network dependency.

Any change to canonical invocation semantics, producer identity or envelope
shape requires a new version and compatibility review. Compromise of protected
CI, reviewed source or pinned tool distribution remains outside the envelope and
belongs to repository security controls.
