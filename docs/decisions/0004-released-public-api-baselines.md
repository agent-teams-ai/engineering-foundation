---
id: ADR-0004
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0004: Released Public API Baselines

Status: Accepted

Date: 2026-08-02

Decision owner: Product owner

## Context

The shared foundation package needs machine-enforced TypeScript compatibility
without treating a feature branch's current output as authoritative.

## Decision

Use normalized API Extractor snapshots as release-owned evidence. Require
Changesets for additive changes and exact fingerprint plus accepted ADR evidence
for breaking changes. Promote baselines only through the version workflow.

Adding a member below an already released interface, class, or namespace is
conservatively breaking. Promotion validates every configured package before
writing, is replay-safe after partial failure, and fails on same-version drift.
A consumer cannot enable the capability until required PR CI enforces its
release-owned baseline mutation rule.

## Consequences

Public API drift becomes deterministic and reviewable. API Extractor remains
replaceable behind an outbound port, while extractor upgrades require an
explicit baseline migration.
