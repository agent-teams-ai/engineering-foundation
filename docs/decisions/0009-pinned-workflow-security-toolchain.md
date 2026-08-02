---
id: ADR-0009
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0009: Pinned Workflow Security Toolchain

Status: Accepted

Date: 2026-08-02

Decision owner: Product owner

## Context

Full commit SHAs prevent tag movement but do not prove that every workflow use
was reviewed or that GitHub Actions syntax and security semantics are sound.

## Decision

Extend `repository.security-baseline` with a closed allowlist for direct
workflow uses and recursively inspect local composite actions. A remote action
or reusable workflow pinned by full commit SHA is an opaque reviewed trust root:
an offline consumer checkout cannot prove its internal transitive dependencies.
Any claim about remote transitive pinning requires separate producer-owned
qualification rather than an empty local declaration. Run
actionlint and zizmor as pinned external CI gates installed through Aqua with
committed checksums. Run CodeQL as an independent hosted analysis workflow.

The normal capability remains read-only and subprocess-free. External tool
results may be qualified through versioned evidence, but missing optional
qualification cannot be represented as a successful run.

## Consequences

Workflow dependencies, syntax, common security hazards, and source-code security
analysis are independently enforced. Tool versions and cross-platform artifacts
are explicit and reviewable rather than downloaded by unpinned install scripts.
The guarantee is intentionally scoped: local recursion is proven, while the
internals of a pinned remote trust root remain the responsibility of its owner.
