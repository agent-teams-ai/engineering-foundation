# ADR-0003: Governed Inline Suppressions

Status: Proposed

Date: 2026-08-02

Decision owner: Product owner

## Context

Large agent-maintained repositories need rare local suppressions without
allowing permanent or invisible quality-policy bypasses.

## Proposed decision

Adopt the exact, expiring, owner-backed waiver model in
[Suppression governance](../architecture/suppression-governance.md). Keep
security and tenant-isolation rules non-waivable and prohibit broad or legacy
directives.

## Consequences

Suppressions remain possible for bounded technical debt, but every exception is
discoverable, expires, and is tied to reviewed evidence.
