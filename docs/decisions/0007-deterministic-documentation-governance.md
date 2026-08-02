---
id: ADR-0007
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0007: Deterministic Documentation Governance

Status: Accepted

Date: 2026-08-02

Decision owner: Product owner

## Context

Large agent-maintained repositories need reliable local links, anchors, and ADR
history without moving product-specific documentation policy into a shared tool.

## Decision

Provide two independent capabilities:

- `documentation.local-references` validates local Markdown targets, directory
  indexes, anchors, containment, and symlink safety;
- `governance.architecture-decisions` validates ADR identity, lifecycle,
  supersession, index membership, and immutable accepted-decision baselines.

Markdown parsing is an outbound adapter backed by established CommonMark/GFM
libraries. Consumer-specific required headings, terminology, ownership catalogs,
code anchors, and diagrams remain consumer-owned rules.

No documentation website, visual search interface, or VitePress dependency is
part of this decision. Such a surface requires explicit product-owner approval.

## Consequences

Generic documentation integrity can move from Orchestrator into the foundation
without turning the foundation into the owner of Orchestrator documentation.
Machine-readable indexes may be added only as rebuildable caches, never as a
second source of truth.
