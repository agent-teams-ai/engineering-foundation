# ADR-0002: Oxc Source Dependency Adapter

Status: Proposed

Date: 2026-08-01

Decision owner: Product owner

## Context

`architecture.source-dependencies` needs a parser that understands current
JavaScript and TypeScript syntax without exposing parser-specific types through
the capability contract. The executable parser spike compared Oxc 0.142.0 with
an isolated TypeScript 6.0.3 oracle against independent expected fixtures.

## Proposed decision

1. Use exact `oxc-parser` 0.142.0 in the outbound parser adapter.
2. Keep parsing, dependency resolution, workspace discovery, and policy
   evaluation behind separate internal ports.
3. Discard all partial dependency evidence when parsing reports any error.
4. Fail closed for unresolved local imports, unsupported specifiers,
   unclassified files, and non-literal runtime references unless the owning
   consumer boundary explicitly allows that reference kind.
5. Keep package identities and exports authoritative in workspace manifests.
   Consumer architecture YAML owns only opaque boundaries and allowed edges.
6. Keep TypeScript 6 only as a test oracle during the observation window.

## Implementation evidence

The candidate implementation is complete and dogfooded by this repository. It
has adversarial capability fixtures, parser parity evidence, macOS local
verification, a real tarball consumer test, and required Linux and Windows jobs
in the pull-request workflow. This implementation evidence does not change this
ADR to Accepted.

## Consequences

- Oxc remains replaceable behind a foundation-owned port.
- `oxc-parser` is a runtime dependency of the development-only foundation
  package, not of consumer production code.
- Parser-native AST types never cross into application policy or public schemas.
- Replacing Oxc requires the same corpus, package conformance, and a superseding
  decision.

## Approval condition

Change this ADR to Accepted only after explicit product-owner confirmation and
green Linux and Windows pull-request checks.

The reproducible evidence is recorded in
[Source dependency parser spike](../research/source-dependency-parser-spike.md).
