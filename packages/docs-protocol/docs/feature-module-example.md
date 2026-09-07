# Consumer-owned feature boundaries

This disposable example uses the existing `architecture.source-dependencies`
schema v2. It illustrates a consumer's vocabulary and explicit import policy;
it neither imposes this topology on other consumers nor proves all of SOLID or
semantic DDD correctness. No aggregate or plugin mechanism is needed for the
small availability query.

The example's `@workshop/stock` module owns one `availability` feature. The pure
quantity predicate enforces its local invariant. The application coordinates a
query through its own narrow `StockReader` port. A memory adapter implements
that port, and the package entry point composes the feature. Production product
code in this example has no Foundation import; Foundation is development tooling.

```text
packages/stock/src/
  index.ts                              module composition/public API
  features/availability/
    domain.ts                           curated domain API
    domain/quantity.ts                   deterministic availability rule
    application.ts                      curated application API
    application/availability.ts         use case and consumer-owned port
    adapters/memory.ts                   StockReader implementation
```

The explicit edges are:

| Caller | Allowed target |
| --- | --- |
| Domain | No outside boundary |
| Application | Availability domain API |
| Memory adapter | Availability application API |
| Module composition | Availability application API and named memory adapter |

The versioned configuration and executable source fixture are in
[the repository's feature-module example](https://github.com/agent-teams-ai/engineering-foundation/tree/main/packages/docs-protocol/tests/fixtures/feature-module-example).
The policy is data-only YAML; `packageRoots` selects the v2 package universe,
`governedRoots` names observed source, and each boundary declares exact roots,
entrypoints, packages, builtins and runtime-reference permissions. There are no
executable consumer hooks. This uses current package/boundary permission
semantics; it does not introduce a subpath permission DSL.

`portable-dx.test.mjs` copies that fixture into a disposable repository and runs
the real source-built Foundation CLI. The complete example passes. An
application import of its adapter fails, and a composition import that bypasses
the curated application entry point fails. The fixture is mechanism evidence,
not a second real consuming repository or proof of extraction admission.

A consumer adopting this pattern must retain its own vocabulary, invariants,
ADRs and tests, and run its configured full checks as required CI. Fast and
changed checks remain local feedback. See the canonical
[consumer adoption contract](https://github.com/agent-teams-ai/engineering-foundation/blob/main/docs/development/consumer-adoption.md).
