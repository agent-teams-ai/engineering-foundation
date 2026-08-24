# DeepSeek Harness Tooling Comparison

Status: Evidence review completed on 2026-08-22 and revalidated on 2026-08-25.
Recommendations are not architecture decisions by themselves.

Compared revisions:

- Engineering Foundation historical snapshot
  `edfaee28c65eb6ce034ddb6036166da1eafeb15a`, revalidated at PR #192 exact head
  `7d1eb3529b3473efd74a0c8d593c4c5f0fb42dec` and merged as
  `393c51ebaa823d9b107fae287416aa821ac53548`;
- DeepSeek Harness `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.

Required PR CI run `32785270609` and exact-main CI run `32785996812` passed.
The independent strict final architecture audit scored the merged state
**8.8/10** with no P0, P1, or blocking P2 findings.

Current Foundation evidence uses published stable versions `0.18.0` and Docs
Protocol `0.1.2`, with all four real consumers and the canary bound to `stable2`.
Merged PR #192 closed fail-safe lease release, public known-file recovery projection,
bounded argv JSON, the Docs layer fence, broad test suppressions and temporary
file cleanup. ADR-0035 governs public-seam migration and admits shared code only
after two real consumers, parity evidence and deletion of donor duplicates.

The comparison evaluates mechanisms, not repository size or product runtime.
DeepSeek Harness is an agent runtime; Foundation is reusable development-only
policy and qualification tooling. A higher score in one row does not make its
whole architecture transferable.

## Strict comparison

| Area | Foundation | DeepSeek Harness | Finding | Decision |
| --- | ---: | ---: | --- | --- |
| Changed-scope | 9.2/10 | 9.0/10 | Foundation now combines strict path/ref validation with deterministic grouped evidence and safe routing of the normalized union. DeepSeek remains especially strong on Git hardening, including locks, fsmonitor, external diff/text conversion and invalid UTF-8 rejection. | Keep Foundation's boundary; borrow only independently justified Git hardening. |
| Test sharding | 8.3/10 | 8.5/10 | Foundation's isolated manifest shards protect stateful suites and cover 126 cross-platform tests plus 15 Docs coverage-only tests. DeepSeek's native runner sharding needs less manifest upkeep; Foundation still has P3 timing-freshness debt. | Keep explicit isolation and refresh timings from bounded evidence, not on every run. |
| Coverage | 8.9/10 | 9.3/10 | Foundation adopted fail-closed partitioned exact-SHA blocking coverage for all 141 tests. DeepSeek remains slightly ahead in the maturity and simplicity of its native instrumented partition/merge path. | Keep the adopted artifact protocol and qualification; do not copy Vitest-specific code. |
| Package invariants | 9.2/10 | 9.0/10 | Foundation's tarball, registry-install, public API, provenance and published-compatibility checks are stronger at the package boundary. DeepSeek is deeper at runtime invariants inside internal packages. | Keep Foundation release checks; do not add companion `invariant` modules everywhere. |
| Dependency graph | 9.3/10 | 6.5/10 | Foundation checks observed imports, runtime/type edges, boundary and package cycles, unresolved imports, declarations, and exports. DeepSeek's generated graph is shallower but has a convenient Mermaid view. | Keep Foundation analysis; consider a renderer, not their analyzer. |
| Notes and decisions | 9.0/10 | 8.5/10 | Foundation separates immutable ADRs, current architecture, procedures, and research. DeepSeek records alternatives consistently, but mandatory notes and translated triplets create substantial process weight. | Adopt the alternatives discipline only. |
| Snapshot/replay | Not applicable | 9.0/10 | DeepSeek replay is valuable because it owns `AgentLoop`, `SessionEvent`, LLM calls, and session persistence. Foundation owns none of those semantics. | Do not transfer it. |
| Script consumption | 9.0/10 | 9.0/10 | DeepSeek's replay handle proves all recorded calls were consumed. Foundation now uses a small internal sequence helper to prove fault/recovery checkpoints were all reached. | Adopted as a test-only helper, not an API. |
| Effective instructions | 9.0/10 | 9.0/10 | Foundation explains per-file precedence without content injection or runtime ownership. DeepSeek performs deep runtime context injection, which is appropriate for its product but not for Foundation. | Keep the narrow explain-only command. |

## Evidence

DeepSeek evidence reviewed:

- [`scripts/change-scope.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/scripts/change-scope.ts)
  and its specification;
- [`scripts/coverage-partitions.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/scripts/coverage-partitions.ts)
  plus the partition runner;
- [`scripts/package-invariants.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/scripts/package-invariants.ts)
  and built-package verification;
- [`scripts/gen-module-graph.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/scripts/gen-module-graph.ts);
- [Agent Notes](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/.agents/notes/README.md);
- [`llm-replay`](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/test-support/llm-replay).

Foundation evidence reviewed includes the repository agent workflow, the test
shard and coverage manifests, package and registry qualification scripts, the
source-dependency capability, Docs Protocol, and ADR governance. The comparison
uses executable code and tests rather than README claims.

## Adaptation queue

1. **Richer changed-scope evidence** - implemented by preserving the existing
   safe normalized union for routing while reporting committed, staged,
   unstaged, and untracked groups, exact base/head/merge-base identities, and a
   deterministic scope digest. Git discovery remains one hardened path.
2. **Partitioned coverage artifacts** - adopted as fail-closed blocking coverage:
   isolated jobs publish the complete expected exact-SHA artifact set, which is
   merged once before thresholds are applied. Keep parity and artifact identity
   qualification; no Vitest-specific transfer is needed.
3. **Source-graph renderer** - add a deterministic Mermaid or table projection
   over Foundation's existing observed graph only after a second real consumer
   asks for the same view. Do not add a second analyzer. Estimated change:
   150-300 lines.
4. **ADR alternatives discipline** - require consequential ADRs to record the
   credible alternatives actually considered. Do not require a new note for
   every non-trivial code change.

The two highest-value transfers, coverage artifact protocol and richer change
evidence, are now adopted in Foundation's own contracts. Direct source copying
would save little time because DeepSeek uses Vitest and product-runtime package
conventions while Foundation uses `node:test`, isolated recovery suites, and
release qualification. Semantic parity was the useful transfer boundary.

## Rejected transfers

- no AgentLoop, session event core, runtime context injection, LLM replay
  package, prompt injection, watcher, session log or executable plugin platform
  in Foundation;
- no mandatory Agent Note or translated document triplet for every change;
- no package-wide `./invariant` convention where existing tarball and public API
  checks already own the risk;
- no replacement of Foundation's source-dependency analysis with the shallower
  generated module graph.

These decisions follow the
[extraction admission invariant](../architecture/executable-capabilities.md#extraction-admission-invariant):
shared code requires two real consumers with the same semantics, parity fixtures,
consumer conformance, and actual deletion of the duplicated donor code.
