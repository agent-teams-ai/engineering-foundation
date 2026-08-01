# ADR-0004: Released Public API Baselines

Status: Proposed

Date: 2026-08-02

Decision owner: Product owner

## Context

The shared foundation package needs machine-enforced TypeScript compatibility
without treating a feature branch's current output as authoritative.

## Proposed decision

Use normalized API Extractor snapshots as release-owned evidence. Require
Changesets for additive changes and exact fingerprint plus accepted ADR evidence
for breaking changes. Promote baselines only through the version workflow.

## Consequences

Public API drift becomes deterministic and reviewable. API Extractor remains
replaceable behind an outbound port, while extractor upgrades require an
explicit baseline migration.
