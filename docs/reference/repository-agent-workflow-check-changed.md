# Check-changed coverage and v2 migration

Status: C1 continuation source, pending Root composition, artifact admission and
candidate qualification. No release, production Host or consumer adoption claim.

The additive `agent-workflow check-changed` command uses config v2 and report v2.
The published `agent-workflow changed` command, v1 config/schema and typed root
exports retain their historical feedback contract. A v1 policy on the successor
route rejects with a migration diagnostic before executing any consumer script.

Replace `changedChecks` and `fullScanPaths` with explicit `scopes`, `checks`,
`exclusions` and `escalationCheck`. Scopes supply consumer-owned required facets
and check IDs. Checks declare script names, explicit prerequisites, supplied
facets and an observation contract. C1 always executes repository-wide commands;
paths explain selection and are never compiler/test arguments. Overlapping scopes
require the union of their facets and checks. Exclusions apply only to matching
paths and require a reason. Unknown paths and missing declared facets select the
repository escalation; an inadequate escalation remains uncovered. Consumers must qualify
command semantics rather than infer facets from check names.

```yaml
schemaVersion: 2
instructions:
  canonical: AGENTS.md
  claude: CLAUDE.md
  gemini: GEMINI.md
  copilot: .github/copilot-instructions.md
scripts:
  changed: check:changed
  fast: check:fast
  full: check
scopes:
  - id: repository
    roots: ['*']
    requiredFacets: [typecheck]
    checks: [typecheck]
checks:
  - id: typecheck
    script: typecheck
    prerequisites: []
    supplies: [typecheck]
    observation: command
exclusions: []
escalationCheck: typecheck
```

This minimal example covers only project typechecking. A consumer requiring
lint, tests, standards or architecture declares those separately. Route its
`check:changed` script to the installed successor CLI when Root's additive
composition and schema registration are present. Keep dependencies pinned to the
published version until an authorized release; candidate installs are TEST data.

A successful mutable checkout returns `feedback-only`, binding `unverified`,
raw command history and uncovered facet rows. It never reports qualified facets
or checked bytes. Matching before/after digests cannot freeze an input closure.
The current Node CLI Host has no trusted complete-closure custody or script/tool
qualification provider. Its mutable pnpm adapter explicitly disables implicit
pre/post scripts, dependency verification and automatic manager-version changes,
but does not qualify transitive commands, environment, tools or byte custody.

A qualified Host must acquire custody before config/Git observation and retain
it through the final report. It supplies a frozen complete influencing closure
or an enforced cooperating ownership protocol, separate output/cache roots,
exact pnpm package tree and Node executable identities, and reviewed transitive
script/config/tool effects. Foundation verifies bindings and drift; it does not
enforce privileged-writer exclusion. Private frozen TEST copies prove only the
fixture's custody assumption, not production Host admission.

The tests facet requires `test-dispatch/v1` from a qualified wrapper, transported
via `--foundation-observation <absolute-output-file>` and
`--foundation-binding <JSON>`. The closed observation binds invocation, source,
config, check and runner identities, actual selected suites, executed/skipped
counts and outcome. Empty selection may escalate once; missing, forged, no-op,
skipped-only and failed observations cannot supply tests or trigger retries.
Existing `test:built` does not emit this transport and cannot qualify tests for
a frozen runner until an owner supplies a reviewed wrapper.

No delta and exclusively excluded paths return `not-checked`. Missing facets
return `uncovered`. Step failures, cancellation and revoked admission fail.
Actual completed commands remain in history if post-run admission is revoked;
output transport cleanup failures also retain history and fail qualification.
Interrupted execution has a nullable command exit status when the executor did
not observe one. Revocation/cancellation clears every qualified facet. Output
is bounded and redacted; protected TEST diagnostics remain separate.

The nearest C1 `.mts` suites exercise real native TypeScript, Node assertions,
pnpm lifecycle sentinels, ABA, persistent drift, run-then-revoke, cancellation,
unknown-path escalation, overlap/exclusion, empty dispatch and forged bindings.
`tests/c1-tsconfig.json` typechecks their actual contracts. Candidate CLI suites
must run on Root's installed archive; missing successor wiring is a failure,
never a skip or a standalone acceptance claim. Complete shard/Windows/mandatory
identities, public/artifact gates, real consumer source qualification and final
native CI remain Root's integration responsibilities.
