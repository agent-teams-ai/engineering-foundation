---
id: ADR-0006
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0006: Observed Source Graph V2

Status: Accepted

Date: 2026-08-02

Decision owner: Product owner

## Context

Path allowlists alone do not prove the effective architecture of a large
workspace. Self-package imports, undeclared boundary entrypoints, runtime
cycles, and type-only cycles can bypass an apparently directional model.

## Decision

Extend `architecture.source-dependencies` instead of creating a competing graph
capability. Build one normalized immutable observed graph before applying policy.
Schema version 2 requires explicit boundary entrypoints and blocks cross-boundary
local imports that do not target one. Evaluate package and boundary strongly
connected components separately for runtime and type-only edges. Keep file-level
cycle detection in the language linter.

Schema version 1 remains readable for migration, but new consumers use version 2.
Self-package imports fail closed until their target boundary can be proven.

## Consequences

The consumer remains owner of its boundaries and allowed directions. Evidence is
deterministic, bounded for large graphs, and independent from parser-native AST
types. Architecture impact analysis may consume the graph later, but it cannot
become a second source of boundary truth.
