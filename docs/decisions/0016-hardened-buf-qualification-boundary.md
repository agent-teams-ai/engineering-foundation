---
id: ADR-0016
status: accepted
supersedes:
  - ADR-0015
superseded_by: []
---

# ADR-0016: Hardened Buf Qualification Boundary

Status: Accepted

Date: 2026-08-05

Decision owner: Product owner

## Context

ADR-0015 introduced producer-owned Buf qualification, but review found that its
first envelope and invocation model did not bind the complete transition. A
finding-set approval could be replayed across different contracts, the evidence
path and generated breaking policy were not both bound, and the process and
publication boundaries lacked explicit cancellation and recovery guarantees.

The accepted ADR and its version 1 evidence schema are immutable. The hardening
therefore requires a successor decision, producer version and envelope schema.

## Decision

The qualification producer and evidence envelope advance to version 2. Version
1 remains published as immutable historical schema data but is not accepted by
the hardened qualifier or normal validator.

Candidate construction runs `buf build` with the consumer-declared module and
configuration and must produce the declared candidate descriptor digest.
Breaking analysis never reopens that mutable configuration for policy. It runs
`buf breaking` with one Foundation-owned canonical inline Buf v2 JSON config:

```json
{"version":"v2","modules":[{"path":"."}],"breaking":{"use":["FILE"]}}
```

The same bytes are supplied through `--config` and `--against-config`, binding
both candidate and baseline interpretation to exact `FILE` semantics. The
canonical invocation records the exact argument sequence and generated policy
digest. The declared configuration and released descriptor are read again after
execution; any change aborts publication.

Envelope version 2 binds the contract, Buf version, module path, declared config
path and digest, evidence path, baseline path and digest, candidate digest,
generated policy digest, canonical invocation, normalized output and findings.
The complete envelope digest is the breaking approval fingerprint. A matching
diagnostic set alone never authorizes another transition.

Every Buf process has a bounded deadline and process-tree cancellation. The CLI
handles `SIGINT` and `SIGTERM`, checks cancellation before publication and uses
exit code `130` for cancellation. Normal checks remain process-free.

Write mode takes a cooperatively cancellable lock before observing existing
evidence. It uses contained canonical paths, rejects symbolic-link traversal,
revalidates parent identity, writes and syncs a private same-directory file,
atomically renames it, rereads the published bytes without following symbolic
links and flushes the directory where supported. Oversized or corrupt old
evidence can be replaced without loading it. An unprovable result after rename
is reported as an uncertain write outcome, never success. A cleanup failure
after a proven durable rename is reported separately from pre-commit
unavailability. Check and producer reads share the same eight MiB evidence
bound.

The repository root `.` is valid only as the explicit Buf module path. Other
qualification paths retain strict repository-relative containment.

## Consequences

Evidence cannot be replayed across paths, contracts, baselines, candidates,
toolchains or invocation semantics. Protected CI rerun remains the source of
producer provenance; hashes alone prove integrity and binding, not actor
identity.

Portable Node filesystem APIs cannot provide an absolute guarantee against a
hostile process running under the same OS identity because directory-relative
`openat` and `renameat` primitives are unavailable. The adapter is deterministic
and robust for cooperative writers and ordinary races. A stronger threat model
requires a separate native adapter and decision.
