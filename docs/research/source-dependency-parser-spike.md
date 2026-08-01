# Source Dependency Parser Spike

Status: Completed evidence; adapter implemented, ADR-0002 accepted

Date: 2026-08-01

## Question

Which parser should back the internal source scanner for
`architecture.source-dependencies` without exposing parser types through the
capability contract?

## Method

The executable corpus compares exact `oxc-parser` 0.142.0 with an isolated exact
TypeScript 6.0.3 Compiler API oracle. The repository remains on TypeScript 7.0.2.
Both adapters map JavaScript, JSX, TypeScript, TSX, MTS, and CTS syntax into the
same normalized dependency references before comparison.

The corpus independently asserts expected truth for static imports, type-only
imports and exports, dynamic imports, CommonJS `require`, TypeScript import
types, import-equals declarations, malformed input, non-literal references,
escaped specifiers, comments, strings, and unrelated call shapes. Oxc also has
an explicit modern-syntax case for source-phase imports.

Run deterministic conformance with:

```text
pnpm parser-spike:check
```

Run the additional non-blocking local benchmark with:

```text
pnpm spike:source-parser
```

## Findings

- Both parsers match the independent expected model on all nine shared cases.
- Oxc accepts source-phase imports that TypeScript 6 reports as malformed.
- Non-literal dynamic imports and `require` calls remain unresolved and fail
  closed; parser errors discard partial edges.
- A shadowed string-literal `require` is conservatively treated as an edge. Scope
  analysis is outside the parser adapter's responsibility.
- On an Apple Silicon development host, the complete Oxc parse, AST transfer,
  visit, and normalization path was about 24-26% slower than the TypeScript 6
  path for the small, medium, and large synthetic profiles. The difference is
  small enough for a complete CI architecture scan, but it disproves any claim
  that Oxc is automatically faster for this exact workload.
- TypeScript 7 does not expose the established Compiler API from its stable root
  export. Depending on `typescript/unstable/*` would make the architecture gate
  depend on an intentionally unstable API.

## Recommendation

Use Oxc behind a foundation-owned internal `SourceDependencyParser` port. The
candidate capability now does this. Keep the normalized model, expected corpus, and
fail-closed behavior parser-neutral. Retain TypeScript 6 only as an isolated
test oracle during the observation window; it must not enter production runtime
dependencies or consumer configuration.

This decision prioritizes current syntax coverage and a supported parser API over
a modest synthetic throughput advantage. GitHub CI proved the native Oxc package
on both Linux and Windows before acceptance. Before the scanner becomes blocking
in large consumers, measure full-repository latency and memory against an explicit
budget; do not derive a pass threshold from this microbenchmark.

## Guardrails

- Parser package types never cross the internal adapter boundary.
- Parse errors and unresolved governed references fail closed.
- Cache keys include parser version, capability version, file content hash, and
  parsing policy version.
- Timing values are diagnostic evidence, not deterministic CI assertions.
- Replacing the parser requires the same corpus, consumer conformance, and a new
  accepted decision.

## References

- [Oxc parser usage](https://oxc.rs/docs/guide/usage/parser)
- [TypeScript 7 native port](https://devblogs.microsoft.com/typescript/typescript-native-port/)
