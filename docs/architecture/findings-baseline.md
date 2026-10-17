# Findings Baseline, Growth Budgets and Source Graph

Status: Implemented. Architecture-neutral core mechanisms; they read every
architecture fact from consumer-owned data (see
[Architecture neutrality](executable-capabilities.md#architecture-neutrality)).

## Findings baseline

A findings baseline records the violations a repository already has, so that a
rule can be enforced for new code before the old code is clean. It only
shrinks.

- One entry per file and rule: `path`, `rule`, `count` and, for a rule that
  measures something (lines, parameters), the largest measured value `max`.
- The file is canonical JSON Lines: a `{"findingsBaseline":1}` version line,
  then one object per entry in binary order. Hand edits that reorder,
  duplicate or add fields are rejected.
- A finding that has no entry, or that is above its entry, fails as new or
  worse. An entry above the observed finding, or for a vanished finding, fails
  as stale. Entries never expire and carry no dates or line numbers; this is
  not suppression governance and has no waivers.
- `prune` only lowers entries to the observed values and removes entries
  without a finding. It never adds or raises an entry, and it reports the new
  and worse findings it cannot accept.
- `init` writes the first baseline and refuses when the file exists.
- Each producer owns a rule namespace (`oxlint/...`) and verifies only its own
  entries. Other producers, for example checks a consumer runs in its own
  tests, use the pure functions of `@agent-teams/engineering-foundation/ratchet`
  with their own namespace. One baseline file per producer: `init` refuses an
  existing file, so a repository with several producers keeps one file each.
- A move updates the entry path in the same commit; the file must stay
  canonical (sorted), and the diff then shows a pure rename.
- Accepted limit: a canonical hand edit that raises or adds an entry passes
  `check`. Shrink-only is enforced by the commands and by review, like the
  accepted limits of the active gate in
  [public API compatibility](public-api-compatibility.md).
- Adding a rule to `measuredRules` after `init` makes its entries "worse"
  (they now carry a measured value) and `prune` cannot accept that, so it needs
  a reviewed re-init.

### Oxlint producer and commands

`quality.findings-baseline` is the Oxlint producer. Its configuration
(`quality-findings-baseline/v1`) names the baseline file, a consumer-owned
Oxlint configuration, the source roots and the measured rules:

```yaml
schemaVersion: 1
baselinePath: architecture/foundation/findings-baseline.jsonl
oxlint:
  configPath: .oxlintrc.baseline.json
  roots: [packages]
  measuredRules: [eslint/max-lines, eslint/max-lines-per-function, eslint/max-params]
```

It runs the consumer's pinned Oxlint through the same session as
`quality.source-coverage`. Findings are recorded as `oxlint/<plugin>/<rule>`.
A measured rule carries its value in the first parenthesized integer of its
message; a rule whose message has none fails as `FINDINGS_BASELINE_CONFIG_INVALID`.
The verified measured rules are the ESLint `max-lines`, `max-lines-per-function`,
`max-params`, `max-depth`, `max-nested-callbacks`, `max-statements` and
`max-classes-per-file`. Point `roots` at source directories or ignore build
outputs in the Oxlint configuration, and keep the baseline LF-only, for example
`<path> text eol=lf` in `.gitattributes`.

```text
agent-teams-foundation baseline check --config <file> [--consumer <path>]
agent-teams-foundation baseline init  --config <file> [--consumer <path>]
agent-teams-foundation baseline prune --config <file> [--consumer <path>]
```

Requirements of the Oxlint producer: `pnpm-workspace.yaml` at the consumer root;
the exact root devDependencies `oxlint` 1.83.0, `oxlint-tsgolint` 7.0.2001 and
`typescript` 7.0.2, installed; an Oxlint upgrade needs a reviewed re-init.
Count and `max` are per file and rule. Rule codes must match `^[a-z][a-z-]*\(`,
so a plugin whose name has a digit, such as `jsx-a11y`, is not supported.
If every file under the roots is ignored by the Oxlint configuration the
commands fail as an input error ("Oxlint linted no file under the configured
roots"); batches that hold only ignored files are fine.

The commands take the configuration path directly. The capability is not yet a
key of `foundation.config.yaml`: the released `foundation-config/v2` schema is a
closed, digest-protected artifact, so declaring it there needs a new
configuration version and its own decision.

## Growth budgets

`checkBudgets` compares measurements (`subject`, `metric`, `value`) with
thresholds and returns warnings only; `formatBudgetAnnotations` renders GitHub
workflow warning annotations. A threshold with a `subject` replaces the general
threshold of its metric for that subject. The functions know no features, roles
or modules.

## Source graph

`observeSourceGraph` returns the files under the given roots and their resolved
import edges (`from`, `to`, `kind`, `mode` runtime or type-only, `line`), the imports
that did not resolve to a file in the roots, the bare specifiers in `external`
and the files that did not parse. Bare specifiers (packages, workspace
packages, tsconfig paths aliases) are reported in `external`, not as edges;
consumers that need alias resolution resolve them themselves.
Resolved, unresolved and external imports retain the parser's reference kind
and mode. Computed or otherwise unprovable loaders remain visible in
`unresolvedRuntimeReferences`; they are not resolved edges. A runtime mode alone
does not prove load-time execution: consumers may enforce a static-import subset
by rejecting the observed dynamic and CommonJS kinds.

`runtimeExports` contains one record per observed file. Its `status` is
`complete`, `unsupported` or `parse-failure`; only `complete` establishes the
export count. The records observe direct ESM function declarations, direct
function/arrow expressions and other direct values such as literals,
objects, arrays and classes (reported as `value`). Type-only and explicit `declare`
declarations are erased. Other ambient forms remain unsupported.
Calls, local/imported binding exports, re-exports, `let`/`var` exports and other
unclassified expressions retain an `unsupported` location instead of guessing a
kind or returning a complete empty list. Script/CommonJS files are outside this
export subset. Values are not executed and this static declaration inventory
does not establish module execution behavior. Parse failures discard both
dependency and export facts for that file. Consumers that need export facts
check each selected file's status before using its count or kinds.

`stronglyConnectedComponents` returns the components of any edge set; filter
the edges first for a runtime-only or type-only view. Only components with more
than one file are returned; a self-import is visible in edges. It reuses the parser and
resolver of `architecture.source-dependencies` with one synthetic boundary and
no feature or role vocabulary.

Public subpaths: `@agent-teams/engineering-foundation/ratchet` (baseline and
budgets) and `@agent-teams/engineering-foundation/source-graph`.

## Admission

These mechanisms are shared from the start under the
[extraction admission invariant](executable-capabilities.md#extraction-admission-invariant).
Reuse is expected: every repository that turns on a lint, size or layout rule
over existing code needs the same ratchet, every checker of module structure
needs the same file graph, and the Feature Module Standard package and its
runner build on both. The contract stays minimal (records and pure functions,
no feature or role vocabulary) because Foundation is 1.x and a later break
needs a major version.

Validation in this delivery (the contract is proven here, not incubated here):

- Disposable test projects: `tests/findings-baseline-*.test.mjs` and
  `tests/source-graph.test.mjs`.
- Real-data parity for the source graph: the Foundation source tree parses
  completely and has no runtime import cycle. This is parity on real data, not
  a second consumer. PR #398 does not import `./source-graph`. The real
  consumer of the source graph is the follow-up `./node` runner of the Feature
  Module Standard package (after PR #398; not yet opened). Hold: the Version PR
  for 1.8.0 must not be merged before that runner merges. The consumer of
  `checkBudgets` is the agent-runtime growth budgets (wave 0b, later).
- Real consumer of the findings baseline: agent-runtime, run against a
  disposable detached checkout of `origin/main` at
  `efd3348f361fa6af84953325af5c0d2d8677d14a` with this branch's CLI, the
  consumer's pinned Oxlint 1.83.0 and oxlint-tsgolint 7.0.2001, and a
  size-rules-only configuration (`max-lines` 300 and `max-lines-per-function`
  60, both skipping blank lines and comments, `max-params` 4,
  `typescript/method-signature-style`), roots `packages`, test files, fixtures,
  generated and vendored code ignored. At that commit there is no `*.module.ts`
  under `packages`, so the 80-line override for module files never applied.

  | Rule | Entries (path and rule pairs) | Findings |
  | --- | --- | --- |
  | `oxlint/eslint/max-lines` | 84 | 84 |
  | `oxlint/eslint/max-lines-per-function` | 184 | 237 |
  | `oxlint/eslint/max-params` | 70 | 92 |
  | `oxlint/typescript/method-signature-style` | 216 | 785 |
  | Total | 554 | 1198 |

  This first probe also counted support files under `tests/` directories. A
  re-measurement without them gives 77 `max-lines`, 172
  `max-lines-per-function` and 81 `max-params` findings and 265 path and rule
  pairs, exactly the numbers of the agent-runtime handoff. For
  `method-signature-style` the production code shows 760 findings in 202 files
  against 45 in the handoff; the scope of the handoff for that rule is unknown,
  so those two numbers are not comparable. Measured values (largest `max` per
  entry, up to 500 lines) were parsed from real messages without a failure.
  Commands, all run from the checkout root:

  ```text
  agent-teams-foundation baseline init  --config foundation.baseline-probe.yaml --consumer <checkout>   # 554 entries, about 12 s
  agent-teams-foundation baseline check --config foundation.baseline-probe.yaml --consumer <checkout>   # passed, about 4.5 s
  ```

  One edited file (an appended five-parameter function and twelve extra lines
  in a file already at 500 lines) failed `check` as two `worse-finding`
  diagnostics; a five-parameter function appended to a clean file failed as
  `new-finding`; `prune` refused both (exit 1) and listed them under "Not
  accepted"; after restoring the files `check` passed. Raising four recorded
  maxima by hand made them `stale-entry`; `prune` lowered exactly those four
  entries (exit 0) and `check` passed again. A file that no longer parses makes
  the pinned Oxlint return an error envelope, which stays an unexpected failure
  rather than a baseline diagnostic. The probe ran on a checkout without build
  output; a run after a build, where `dist` directories exist, could not be
  repeated on the machine of this delivery and is covered by the regression
  test for ignored files instead.
- Agent-runtime adoption is follow-up work and is not part of this delivery:
  adopting the commands, deleting its interim Oxlint legacy lists and adding its
  conformance test (ADR-0061) belong to the agent-runtime refactoring agent
  (wave 0b). Cost of the deviation: agent-runtime's CI contract rejects new or
  changed leaf commands in `check` and `check:fast` until CI-CONTRACT-1
  (`scripts/ci/policy.ts`), so CLI-only adoption there waits for CI-CONTRACT-1
  or an exception owned by its integrator. The capability is a command module,
  not a key of `foundation.config.yaml` (see above), which is what that
  deviation costs a consumer.

How the contract evolves:

- The baseline file carries a version line (`{"findingsBaseline":1}`); a change
  of its shape is a new file version read by the same functions, never a second
  parallel format.
- The producer namespace (`oxlint/...`) is the extension point for new
  producers. A producer owns its file; shared code stays the pure functions of
  `./ratchet`. A second producer is added when a second consumer needs it.
- The subpath is named `./ratchet` because it covers the findings baseline and
  the growth budgets. Both are records and pure functions, so additive fields
  (for example `external` in the source graph) are minor changes. While the
  package is 1.x a breaking change needs a major version, which is why the
  surface stays small.
- Declaring the capability in `foundation.config.yaml` needs a new
  configuration version and its own decision.
