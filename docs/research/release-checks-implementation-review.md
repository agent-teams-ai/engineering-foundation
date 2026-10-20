# Release Checks implementation qualification

Status: Foundation source implementation and focused qualification complete.
Final-source review, complete CI and local changed-check results are recorded on
[owner PR 421](https://github.com/agent-teams-ai/engineering-foundation/pull/421).
Public admission remains unmerged until the existing npm provider-readiness gate
is established. Publication and external adoption are not completed by this record.

The [delivery plan](../development/release-checks-delivery-plan.md) passed its
three sequential improvements and three sequential critical reviews before
implementation. [Their record](release-checks-plan-review.md) retains the actual
reviewed revisions and ten material findings. This file records implementation
qualification separately.

## Implementation corrections

| Observed issue | Correction and verification |
| --- | --- |
| Clean artifact stages need an explicit compiler development input | Reused the exact TypeScript catalog declaration and existing compiler custody; two actual clean builds and installed consumers prove the compiler is not a runtime dependency |
| The conformance declaration referred to two types not exported from that entry | Re-exported its already root-public `DiagnosticCode` and `PackageChange` types; native extraction and installed declaration compilation passed |
| A normalized `none` record could carry different old/new versions | Both the official-plan normalizer and pure boundary reject that contradiction; retained engine and pure counterexamples passed without computing a version |
| Native executable bytes are specific to the operating system | Portable engine binding uses the runtime version and package contents; local custody retains actual paths and native executable hash; copied-installation and independent-base tests passed |
| Reusing the retained files-policy module during its top-level CLI await deadlocked | Completed module initialization before running the CLI, with explicit fatal error handling; the actual files CLI passes valid engine output and rejects a forged Bun lock SRI |
| The normal all-package API promoter encounters a pending earlier public API addition | Created only the new initial anchor through the existing native promotion owner; kept the full production policy and verified all nine typed/artifact surfaces and all 13 unchanged historical baseline hashes |
| Complete source coverage found the new package missing from suppression governance | Added its complete source root to the existing governed roots; no waiver or suppression was added |
| The actual installed TEST canary has no Git-root package manifest | Removed the unconditional root-manifest assumption; the inventory must contain actual packages and retain exact paths and complete manifest/diff relations. Shared nested-package positive and unclassified-root negative cases cover the correction |
| The Host's intent filename rule differed from the pinned Changesets reader | Matched Changesets 2.31.1 direct, non-hidden lowercase `.md` discovery and case-insensitive README exclusion. Real engine release and no-release cases retain those documents and reject their edits; dotted intent names and the V2 `AGENTS.md` intent remain accepted |

No generic release manager, compiler-stage exception, public Foundation facade,
new publisher or version-selection algorithm was added.

## Executed local qualification

These are actual pre-commit source checks. The final required native CI must
qualify its own exact head/base and cannot reuse these as hosted receipts.

| Boundary | Observed result |
| --- | --- |
| Pure core and shared conformance | 22 tests passed again after the typed correction below with normal Node process isolation; before that correction the combined core and six actual-engine Host tests passed all 28 cases |
| Actual-engine Foundation Host | 6 integration tests passed, covering frozen plans, pre-baseline checks, independent base reconstruction, complete diff, execution drift and the actual pinned reader's filename rules |
| Retained release, freshness, bootstrap and migration routes | 118 tests passed; final collector/registry delta suite passed 16 tests |
| Authentic pinned action/Changesets lock fixture | Actual Changesets 2.31.1, Bun 1.4.3, pnpm 11.20.0 and Node 26.11.1 passed generation and source/lock checks; the FMS peer floor was preserved and a forged Bun SRI rejected |
| Admission and catalog authorities | 68 tests passed; nine-package release, source and feature inventories and complete 338-test/eight-shard manifests passed |
| Installed package | Two byte-identical clean-stage archives; offline packed and no-uplink registry consumers passed TypeScript 7.0.2 declarations and all 12 public common cases |
| Initial API evidence | One new initial anchor; complete nine-package typed/artifact check passed; 13 historical baseline files unchanged |
| Workflow security | Required pinned workflow security command passed with no new findings or suppressions |
| Required pre-PR source gates | `bun tools/dev.mts check:changed` passed its complete `fast-full` selection against the original accepted base; the separate `bun tools/dev.mts check:fast` also passed after complete suppression-governance admission |

The retained [installed qualification](evidence/release-checks/p1-installed-qualification.json)
binds archive SHA-256
`d5e6eb3a48ea65f900ec18060dc1bfdb46fa2c3b694d2db1b239c698329318fe`.
This is candidate `0.0.0` from local clean stages and a local registry; it is not
the protected Ubuntu publication writer, a public npm release or E2E completion.
The [initial API record](evidence/release-checks/p1-initial-api-baseline.json)
retains the exact new write and all old baseline digests.

## Final review and delivery record

The independent release correctness and source-custody reviewer returned GO on
the actual working-tree implementation over documentation HEAD
`b72bb4945968461e365b72adbe25f1472e1cdadd`, independently matching source-tree
digest `214b4a809815be2f8339e53fadc9c7dd98dd06590d4d747418af58bd7eb061bb`.
The reviewer ran all 25 kernel, conformance and actual-engine Host tests with
normal Node isolation, verified the one initial API anchor and all 13 unchanged
historical baseline hashes, and found no material defect. Two suspected
counterexamples were rejected by retained policy or Changesets itself.

That review predates the one-line suppression-governance admission correction
above. Confirmation against the eventual exact implementation commit and its
intervening delta remains required. The documentation HEAD alone does not
contain the implementation and is not a reviewed implementation commit.

An independent delta review of the later nested-package correction returned GO
for behavior at source-tree digest
`344f4793880d323383c3cf0755e21a267751c07b2d8037dbb7a7bfd3178fdc6d`, over
`99fd92f61c39958b98317bb1c70a9c7c69f07cda`. All 12 public common cases and
additional missing-manifest, hidden-field, wrong-root and unexpected-root-diff
counterexamples passed. The reviewer requested one public README clarification:
the complete nonempty inventory includes a root manifest when it actually
exists, and paths always remain relative to the full Git repository. That
clarification is applied. The delta review also verified exact preservation of
the upstream owner release and the one-line suppression-governance admission.

The later consumer review exposed a separate Host filename mismatch. Foundation
uses Changesets 2.31.1 and its actual `@changesets/read` 0.6.7 behavior; its
adapter does not inherit the additional instruction-document exclusions in the
consumers' Changesets 3.0.2. Ignored files remain in the complete Git observation
and have no permitted candidate change. The added actual-engine case passes
both a release and a no-release source, then rejects edits to every ignored
document. This Host-only correction left the then-qualified leaf archive
unchanged. The later typed correction and its new archive are recorded below.

Required final-head CI, owner PR, publication and three separate real consumer
adoptions will be recorded here as they are observed. The existing canary's
fresh complete owner-PR chain remains a distinct P6 requirement.

## First full CI corrections

[PR 421](https://github.com/agent-teams-ai/engineering-foundation/pull/421) was
opened at `f849ec4882df164d357f2c2e1ac3271488aaff56` against protected base
`4ca4ad30b1efc5e3b43a2c012348ea8afea21864`. Independent exact-commit review
returned GO and is recorded on the PR. The explicitly requested
[first full CI](https://github.com/agent-teams-ai/engineering-foundation/actions/runs/39464340579)
then exposed additional integration gaps. Its failed results remain failed;
they do not qualify the subsequent corrected head.

- Typed source coverage rejected a double `unknown` assertion at the input
  boundary. The complete runtime validator now expresses its result through an
  assertion signature. Explicit descriptor booleans and an immutable empty tuple
  also satisfy the actual typed linter. No validation or governed source scope
  was removed. Build, full typed lint and all 22 pure/common cases passed.
- Historical published compatibility called the global publication guard before
  inspecting the newly admitted `0.0.0` candidate. Its separate owning entrypoint
  now validates all source manifests and reports bootstrap-stage packages as
  pending, with publication unclaimed. Every advanced historical baseline keeps
  its previous verification. Both candidate admission and the later approved
  `0.0.0` approval PR can run compatibility before the first publication. Default
  live-baseline verification and full-baseline verification remain strict.
  The ordinary release entry additionally checks the complete approval catalog
  before selecting a release subset. The scoped bootstrap/compatibility suite
  passed 65 tests, including rejecting counterexamples for the publication hold.
- Current publication fixtures still modeled eight packages. They now contain
  the ninth leaf with its own archive identity and provenance, retaining exact
  publication, inspection, recovery, tag and signature assertions. Ordered
  publication passed 42 tests, publication policy passed 14 and diagnostics
  passed 42. The runtime probe supplies the unreleased leaf's staged changelog
  only inside its disposable intercepted child. Historical accepted evidence
  and the real unreleased changelog are unchanged.
- Architecture and clean-rebuild fixtures now represent the actual ninth
  package. Complete Windows traversal expectations include the newly admitted
  tests; neither their union nor their platform scope was reduced. The focused
  inventory suite passed 15 tests and the actual compile-clean-rebuild case
  passed.
- Two Windows Host fixture failures were reproduced independently. Git checkout
  filters changed accepted source bytes during replay, and a copied CLI fixture
  assumed all dependencies were installed in one ancestor directory. Owned test
  repositories now set `core.autocrlf=false` before their initial commit, and the
  copied CLI preserves real declared dependency links resolved by its original
  issuer. Raw source and installation digests remain mandatory. All six Host
  scenarios passed; the affected prerelease case passed again after replacing
  its unchecked JSON assertion. The same confirmed checkout-filter correction
  in the owned freshness fixture passed all 32 existing freshness cases.
  Production Host custody was not weakened.
- Independent review rejected an initial bootstrap fixture correction: seeding
  YAML concealed that the real authority step runs before dependency install.
  The bootstrap CLI now loads the Host only in `check-release`, after the global
  approval guard. The clean-source fixture again has no `node_modules` or
  generated package output. Actual token-window, prepare and early candidate
  rejection are covered by the 74 passing scoped bootstrap tests.

Three macOS jobs in the first run were cancelled before acquiring a runner.
Their check annotations report hosted macOS arm64 capacity constraints. They
executed no qualification and require real native execution in the fresh matrix.

Separate independent reviewers returned GO for the typed correction and the
bootstrap/fixture corrections. The retained installed qualification now binds
the new archive above: two byte-identical clean builds, unchanged declarations,
all 12 public common cases, packed and local-registry consumers, and no runtime
dependencies. The earlier archive
`4c46ed8e2aa0cdd24e2b6b3d45acdf22f0614a777f9baccdf687f0630a55a027`
remains historical preparation evidence in the consumer repositories.

The corrected combined commit still requires its own complete head/base CI.
The npm maintainer-readiness and public-adoption holds remain in force.

## Upstream release reconciliation

After the original pre-PR source gates passed, protected main advanced to
`4ca4ad30b1efc5e3b43a2c012348ea8afea21864`. This existing owner release consumed
seven prior intents, advanced seven package versions and promoted their owned
API baselines. It changes no implementation source or compiler dependency graph.
The implementation branch incorporates that revision without rewriting the
six plan-review commits. All upstream manifest, changelog and historical API
baseline bytes remain authoritative; only the new package's initial anchor is
additional. The initial API record above retains its original historical input
hashes and is not relabeled as evidence for these later baseline versions.

Final required source gates, independent commit confirmation and hosted CI
must qualify the reconciled head against the updated protected base.

Protected main subsequently advanced to
`d5cbfc7bc9f9b735e2874de669814aa8c2435d44`, admitting the explicit changed-check
coverage successor. The branch incorporates its implementation, six canonical
tests, complete mandatory Node test contract, strict TypeScript project, workflow
diagnostic paths, exact pnpm development input and both release intentions.
The combined canonical inventory contains 300 files; all three release-checks
suites retain their explicit Linux and Windows placements. The existing
Foundation archive bound remains 2,776 and the supported FMS peer windows retain
their upstream declaration. Changesets owns the combined release plan.

Both branches had independently allocated ADR-0063. The protected schema ADR,
its API-disposition reference and immutable digest are preserved. Only the
unmerged release-checks admission is renumbered to ADR-0064, with its owning
links and actual digest updated; its decision text changes only that identifier.
The prior branch identity and bytes remain in Git history. None of the six
completed plan-review revisions or their recorded hashes is rewritten.

Independent merge review caught a raw-file hash in the new ADR ledger entry.
The existing `architecture-decisions-promote-baseline` owner re-admitted ADR-0064
from the exact protected historical catalog. Its canonical immutable payload
digest is
`sha256:b38ca4441dd30f66cc58b22864005121f48f740556f3659e3f64df2110349a49`;
all 60 historical entries remain unchanged. The source gates run in a clean
worktree of the resulting committed revision.

## Source-owned changed-check composition

At `854efdfe637406d046e38d02cb68625ada05a051`, the new source-owned changed
check reached successful native Foundation checking and the Nx graph, then
stopped. A minimal runtime probe confirmed that the local environment lacked
the explicit generation2 Node required before dispatching built tests. Official
Node 24.21.0 and the historical managed Node 26.10.0 were acquired with their
published archive checksums; the existing managed-test-tools owner provisioned
and verified both copies with pnpm 11.20.0. The default remains Node 26.11.1.
The original failed result is retained, not relabeled as a successful check.

Before repeating the full command, two independent reviewers confirmed a
separate composition contradiction inherited from protected main. C1 selects
`bun run check` in the actual source checkout, but the unchanged package owner
requires the real isolated pnpm projection. An actual pack-owner preflight
rejected the source Bun root before creating any package stage. A Node launcher
for `check:changed` still returns to the source Bun operation and cannot resolve
that contradiction.

The private `check:changed:repository` wrapper now delegates to the existing
Node-profile install and full-check commands. It verifies the actual Node,
binds the actual source root and HEAD, and creates a fresh owned profile instead
of accepting an inherited target that installation could replace. Ordinary
Git selectors are removed. Installation failure or cancellation prevents the
check, and a full-check failure remains a failure. No projection receipt is
manufactured. The ordinary full script, source Bun selection, all five coverage
facets, scopes, exclusions, escalation and complete test/package inventories
remain unchanged. Changesets, the release-checks leaf and publisher are untouched.

Nine focused process tests passed, including concurrent profile isolation,
hostile inherited source/target selectors, child failure and cancellation, and
linked-parent rejection. Both strict tooling projects passed on TypeScript
7.0.2; the new wrapper passed the existing fast and typed linters, and the test
file passed fast lint. These
boundary probes do not claim actual profile installation or full qualification;
the final real changed check and complete head/base CI provide their own results.
A successful mutable C1 command still supplies feedback only, with unverified
input binding and no qualified facets. The public-admission hold remains active.

The independent composition reviewer returned GO for the complete eight-file
correction, committed as `c78d5af0b319cb5d1fd08da2de4734d50264ce12`. The review
verified unchanged full-check scope and the existing outer C1 process-containment
owner; the private wrapper introduces no separate process framework.

The preceding source revision `854efdfe637406d046e38d02cb68625ada05a051` completed
[full CI 39472384148](https://github.com/agent-teams-ai/engineering-foundation/actions/runs/39472384148)
against base `d5cbfc7bc9f9b735e2874de669814aa8c2435d44`: all 35 jobs succeeded,
including Linux coverage, all Windows lanes and every native macOS group. This
is retained evidence for that head/base, not a substitute for the correction's
new complete qualification.

Protected main also completed the Changesets-owned metadata release
`18bc5d1c1310b9837f26ac43b16dab63a087154f`: Foundation 2.0.0 and Feature Module
Standard 0.2.0. The branch incorporates its exact ten-file delta, including the
consumed intentions, manifest/changelog versions, API baselines and Bun lock
updates. That upstream commit changes no implementation or compiler dependency
graph. Its versions and accepted baselines remain authoritative for the final
head/base review and CI; the six historical plan reviews remain unchanged.

## Ordered publisher visibility reconciliation

Protected main advanced to
`d43f9aeb245549d5efe64c2cfe7fb4013098a71a` with a bounded fifteen-minute
monotonic visibility deadline after the single npm publication invocation.
The combined branch retains both upstream production publisher files byte for
byte, including deadline propagation through response bodies, uncertain-outcome
reconciliation and constructed lifecycle diagnostics.

The two test conflicts preserve every upstream regression and the existing
nine-package graph. The delayed-visibility positive case begins with the new
leaf already published, still invokes publication exactly once, and verifies
nine signatures and reconciliations. The shared fixture retains all nine
artifacts while adopting the upstream virtual clock and visibility budget. The
runbook counts nine possible waits. A whitespace-only import reflow preserves
the existing test-file line budget without removing assertions or adding a waiver.

The independent composition reviewer returned source GO. The actual combined
ordered and diagnostics suites passed 97 tests on Node 26.11.1 with normal
process isolation: 49 ordered and 48 diagnostics, no failures, skips or
cancellations. The authored test files passed the existing scoped fast linter.
Leaf, Host, private/public C1, API, lock, governance and platform-selection bytes
remain unchanged from the preceding reviewed branch. Complete qualification for
the resulting head/base is recorded on the owner PR; earlier runs retain their
original source bindings. The npm maintainer-readiness hold remains active.

## Native Windows cancellation expectation

[Full CI 39478898482](https://github.com/agent-teams-ai/engineering-foundation/actions/runs/39478898482)
completed for `82784dc35bb9f635a9e9334f4006c6dd0d0c4a78` against
`18bc5d1c1310b9837f26ac43b16dab63a087154f` with 32 successful jobs. Windows B
reported one failed test; its failure propagated to the Windows and full-CI
aggregates. The cancellation fixture expected POSIX status 143, whereas its
actual Windows child returned 1. The
[libuv Windows source used by Node 26.11.1](https://github.com/nodejs/node/blob/v26.11.1/deps/uv/src/win/process.c#L1294-L1305)
uses `TerminateProcess(process_handle, 1)` for that termination path.

The existing assertion now requires the exact platform status: 1 on Windows,
143 on POSIX. It retains the real self-terminating installation child and the
exact observation that only installation ran. Production status propagation,
containment, all test registrations and platform selections remain unchanged;
the test is not skipped. Its fresh native Windows result belongs to the new
complete head/base run, not the earlier failed run.

## Source inputs in the full Node profile

Revision `ee99b559e2dde8bcce779b422457ed679e76783d` completed
[full CI 39488511960, attempt 2](https://github.com/agent-teams-ai/engineering-foundation/actions/runs/39488511960/attempts/2)
against `d43f9aeb245549d5efe64c2cfe7fb4013098a71a`, with all 35 jobs successful.
The local source-owned changed check then returned a numeric failed step during
the complete built-test phase. Its mutable runner deliberately omits raw child
output; that original result remains failed.

Independent source review and direct Node execution in the retained genuine
profile reproduced 15 failures in six existing test files. The three diagnostic
runs executed 119 tests: 103 passed, 15 failed and the existing opt-in external
Changesets TEST remained skipped. These runs identify concrete failures without
claiming to reconstruct the discarded original report. The strict-project
admission test passed in 74.7 seconds; its timeout remains unchanged.

The affected fixtures treated their execution directory as the original Bun
checkout. A small test-only helper now resolves source inputs through the
existing explicit Git authority. Original policies, intended Bun manifests and
source Git objects come from that checkout. Runtime imports, tools, compiled
code and temporary profile roots keep their execution ownership. The fixture
which explicitly represents a Bun source also uses the actual Bun installation.
The pnpm setup probe has its own literal workspace boundary, preserving the
rejected manager policy and the observed setup-step exception.

The correction preserves all test identities, negative assertions, strict
projectors, production guards, timeouts and governed inventories. The new helper
belongs to the existing strict tooling project. Fresh focused qualification and
complete final-head CI are required for the corrected revision; the successful
`ee99` run is evidence only for its own head/base.

The existing install/build owners created a fresh genuine Node profile for the
correction. All six focused suites then completed: 119 tests, 118 passed, no
failures or cancellations and the same one existing opt-in skip. The strict
tooling project passed on TypeScript 7.0.2. Independent semantic review returned
GO for the source-input correction and preserved test registrations and guards.
Final committed-source local gates and full CI are recorded on the owner PR.

## Static Host declaration reconciliation

Protected main advanced to
`39d283dba54d9e1cb38ae01b457e53b1eba30048`, adding bounded static Host command
declarations and their quality-source observations. The branch incorporates its
complete eighteen-file delta without conflicts. Seventeen paths retain exact
upstream bytes; the source-dependency policy combines the three new upstream
entries with the existing leaf boundaries. Release-checks, its private Host,
publisher production code, source-owned C1 composition and source-fixture
correction remain unchanged.

The shared private lexer admits a declaration for the owner's later checks; it
does not establish execution or qualification. Missing scripts, cycles, depth,
literal failure, OR and multiline rejection, and full versus scoped coverage
guards remain authoritative. Package script bodies have a 16 KiB UTF-8 bound;
profile and path scalars retain their existing 1,024-character bound. The native
contract retains every earlier record and adds four, for 52 required records.
The complete 300-file canonical and 344-file built inventories remain intact.

The one new private module contributes four compiler outputs. The Foundation
archive ceiling is the upstream 2,780 members, with a regression rejecting the
2,781st. Other package ceilings and the 8 MiB archive bound are unchanged. The
upstream patch Changeset for Foundation and Feature Module Standard remains
intact, including the packed development-input consequence for the latter.

A fresh source build passed. Six focused suites executed 106 tests: 105 passed
and one failed because the local invocation omitted its required job-owned
`C1_TEST_SCRATCH`. The complete affected four-test suite then passed with that
input, without source changes, skips or cancellations. This includes the new
static declaration case; the initial run also passed the quality observations,
native contract owner, pack manifest and exact archive-boundary regressions.

The preceding `cf1cf7117b54121cc158e05883c5acdd39ac8231` fast and workflow-security
gates passed. Its local full changed check and
[requested CI 39504380668](https://github.com/agent-teams-ai/engineering-foundation/actions/runs/39504380668)
were cancelled after protected main advanced. The existing local cancellation
owner drained its selected process group. Those cancelled runs do not qualify
this integration; independent final-source review and fresh complete head/base
gates are recorded on the owner PR. The npm maintainer-readiness hold remains.
