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
  with their own namespace and file or share the file.

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
message.

```text
agent-teams-foundation baseline check --config <file> [--consumer <path>]
agent-teams-foundation baseline init  --config <file> [--consumer <path>]
agent-teams-foundation baseline prune --config <file> [--consumer <path>]
```

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
import edges (`from`, `to`, `mode` runtime or type-only, `line`), the imports
that did not resolve to a file in the roots and the files that did not parse.
`stronglyConnectedComponents` returns the components of any edge set; filter
the edges first for a runtime-only or type-only view. It reuses the parser and
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
needs a major version. Validation in this delivery: disposable test projects
(`tests/findings-baseline-*.test.mjs`, `tests/source-graph.test.mjs`) and the
Foundation source tree itself as a real consumer of the source graph. The
baseline commands are adopted first by agent-runtime when it moves to this
release; its interim Oxlint legacy lists are deleted in that adoption.
