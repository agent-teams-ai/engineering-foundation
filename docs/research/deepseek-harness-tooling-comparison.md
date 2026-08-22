# DeepSeek Harness Tooling Comparison

Status: Evidence review complete on 2026-08-22. Recommendations are not
architecture decisions by themselves.

Compared revisions:

- Engineering Foundation `edfaee28c65eb6ce034ddb6036166da1eafeb15a` plus the
  Effective Instructions change under review;
- DeepSeek Harness `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.

The comparison evaluates mechanisms, not repository size or product runtime.
DeepSeek Harness is an agent runtime; Foundation is reusable development-only
policy and qualification tooling. A higher score in one row does not make its
whole architecture transferable.

## Strict comparison

| Area | Foundation | DeepSeek Harness | Finding | Decision |
| --- | ---: | ---: | --- | --- |
| Changed-scope | 8.5/10 | 9.0/10 | Foundation has stronger path validation and directly routes the normalized union into safe path-aware or full checks. DeepSeek hardens more Git process options and preserves clearer committed, staged, unstaged, and untracked evidence plus exact base, head, and merge-base identities. | Keep Foundation routing; adapt richer evidence and Git hardening later. |
| Test sharding | 8.5/10 | 8.5/10 | Foundation's four isolated CI jobs prevent stateful recovery suites from interfering and use observed-duration balancing. DeepSeek's native runner sharding scales with less manifest maintenance. | Keep isolation; automate rebalance only after measured drift. |
| Coverage | 6.5/10 | 9.3/10 | Foundation runs one sequential selected subset with low global thresholds. DeepSeek runs instrumented partitions, requires the complete artifact set, merges once, then applies thresholds. | Adapt the artifact protocol; do not copy Vitest-specific code. |
| Package invariants | 9.0/10 | 9.0/10 | Foundation is deeper at tarball, registry install, public API, provenance, and published compatibility. DeepSeek is deeper at runtime invariants inside each internal package. These protect different boundaries. | Keep Foundation release checks; do not add companion `invariant` modules everywhere. |
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
2. **Partitioned coverage artifacts** - run several single-worker instrumented
   partitions in isolated CI jobs, require every expected SHA-bound artifact,
   merge once, and apply thresholds to the merged result. Node's coverage format
   needs a qualified merge path before this becomes blocking. Estimated change:
   250-450 lines.
3. **Source-graph renderer** - add a deterministic Mermaid or table projection
   over Foundation's existing observed graph only after a second real consumer
   asks for the same view. Do not add a second analyzer. Estimated change:
   150-300 lines.
4. **ADR alternatives discipline** - require consequential ADRs to record the
   credible alternatives actually considered. Do not require a new note for
   every non-trivial code change.

The highest-value transfer is the coverage artifact protocol, followed by
richer change evidence. Direct source copying would save little time because
DeepSeek uses Vitest and product-runtime package conventions while Foundation
uses `node:test`, isolated recovery suites, and release qualification. Reusing
the protocol preserves DRY at the semantic level without importing the wrong
runtime abstractions.

## Rejected transfers

- no AgentLoop, session event core, LLM replay package, prompt injection, watcher,
  or session log in Foundation;
- no mandatory Agent Note or translated document triplet for every change;
- no package-wide `./invariant` convention where existing tarball and public API
  checks already own the risk;
- no replacement of Foundation's source-dependency analysis with the shallower
  generated module graph.

These decisions follow the
[extraction admission invariant](../architecture/executable-capabilities.md#extraction-admission-invariant):
shared code requires two real consumers with the same semantics, parity fixtures,
consumer conformance, and actual deletion of the duplicated donor code.
