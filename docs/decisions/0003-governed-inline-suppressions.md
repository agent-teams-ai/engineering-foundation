---
id: ADR-0003
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0003: Governed Inline Suppressions

Status: Accepted

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

The organization maximum waiver lifetime is 90 calendar days. Consumers may
require shorter lifetimes and may add protected rule prefixes, but cannot remove
the built-in security, tenancy, and tenant-isolation protection.

## Consequences

Suppressions remain possible for bounded technical debt, but every exception is
discoverable, expires, and is tied to reviewed evidence.
