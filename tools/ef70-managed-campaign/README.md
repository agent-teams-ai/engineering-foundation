# EF70 published-controller disposable campaign

This validation fixture exercises the already published managed controller against
the real Extension Foundation source at `8c16e5dbf24d8a09d9f33fe7c3ee8f38bf74599c`.
It is a bounded test Host in Engineering Foundation, not a reusable public tool or
an adoption of consumer policy by a production package. It makes no change to the
historical M4 lifecycle fixture or to published package implementations.

The job uses the real qualified `docs-2026-11-27-stable35` record at an explicitly
selected immutable Central revision, real registry archives and installation
locks, physical Node 24.22.3 and 26.12.1, Corepack 0.36.0, and pnpm 11.18.0/11.20.0.
The required `authority_revision` input is a nonzero lowercase 40-character commit
SHA. Bootstrap parses this input once, before its own subprocess calls. It reads
the fixed official Central `branches/main` and `git/commits/<SHA>` endpoints,
requires the selected commit to be the current protected main, and obtains that
exact commit's tree. There is no default, branch-name input, implicit latest selection or fallback.

The selected revision and tree are retained in `bootstrap/authority-selection.json`
and `bootstrap-result.json`. The first record also binds both retained raw API
observations by path and SHA256. The canonical Central checkout must match both
identities. Bootstrap rechecks protected main after preparation, and every public
operation freshly checks that same selected revision. A moved authority is an
actual failed precondition; the fixture does not follow a new revision, rebind an existing preparation, rewrite the cohort or treat
cached branch state as current authority. A new execution requires a fresh owned
root and a newly reviewed literal input.

## Scope and results

The finite positive cases are ordinary forward/original restoration (O), stopped
forward and cold resume (F), deliberately quarantined receipt companion (L),
committed Host preservation and explicit overlap reversal (C), positive-phase
committed cold restoration (CC), and actual empty-store activation failure followed
by explicit restoration (M1) or cold forward recovery (M2). Every cold case must
establish its actual stopped process phase. A missed window is failed evidence.

The fifteen negative calls select exact owner diagnostics for runtime, manager,
lock scope/digest, image, pin bytes/mode, consumer root, controller build,
preparation/current digest, Host overlap, stale current HEAD, and completed
republish. A generic nonzero exit, signal, observer failure, timeout or compiler
denial does not count as a product refusal. Four owner guards retain a genuine
released-lease record; their evidence must not be mislabeled as wholly unchanged.

The Host patch is the exact six-file delta from source `8c16e5…` to the previously
reviewed `db48bb3…` checkpoint. Those files do not intersect the actual six managed
paths. Case C therefore creates and clearly labels a separate inert description
change in its disposable `package.json`, proves the overlap refusal, and reverses
only that injected change through an ordinary local commit. Actual Host work is
preserved throughout both committed restoration cases.

No case deletes a completion to manufacture a crash, fabricates a receipt,
modifies a published controller, removes a transaction guard, or substitutes a
fake runtime. Recovery preserves unknown state and stops. Where an actual owned
installation backup needs reconciliation, its captured identity must match before
an atomic rename; partial installations and backup shells remain quarantined as
evidence. Process observations distinguish captured child identities from the
limited same-user process census and never claim whole-host visibility.

## Execution and custody

The ordinary push workflow is restricted to the producer preparation branch
`test/ef70-managed-campaign` and runs the unchanged producer quality checks.
After that exact harness commit passes, a minimal caller in the existing EF
PR #70 invokes the reusable workflow by immutable commit, with the actual
successful producer preflight run as a second selected input and the then-current
protected Central commit as `authority_revision`. Source qualification stays bound
to the immutable harness and all seven ordinary preflight gates; it does not
preselect Central for a later execution. Changes to caller-selected Central data
do not change the frozen EF source, candidate digest, target lock or test matrix.
The campaign checks out that producer commit explicitly and retains the real EF
caller's GitHub repository identity. The caller commit and the producer harness commit
are separate recorded identities; GitHub identity variables are never removed
or substituted. Opening a PR does not trigger another campaign.

Each complete case runs in one job and one canonical owned root under the real
runner temporary directory. Output is external to consumer and controller roots.
Evidence artifacts are retained on both success and failure. The optional
ephemeral GitHub token is scoped to read-only GitHub observations and removed
from public CLI and package-manager subprocess environments. The public
controller continues to use its genuine anonymous authority requests; observed
API rate limits are respected before launching operations, without retrying
managed operations or treating available request budget as authority.

All new maintained TypeScript, including copied observers and orchestration, is
enrolled in the required strict typecheck route. Node type stripping only executes
the fixture. It is not typechecking evidence. No compiler or parser older than
TypeScript 7.0.2 may execute; old source packages are installed with scripts and
pnpm hooks disabled and are observed through the retained successor controller.

The producer validation branch is not intended to merge. Successful artifacts
establish only the actual published-controller campaign. Disposable source
`8c16e5d…` is historical and fixed; subsequent canonical EF adoption must select
the actual advanced EF head after adding the caller. Final EF adoption remains
in PR #70 and separately requires a newly qualified cohort on the repaired Central
source, permitted enrollment, actual EF checks and protected merge, merged-main
checks, archive/LMU reconciliation, observed binding, and the separate CANARY.

## Focused authority admission checks

`tests/ef70-managed-campaign-authority.test.ts` exercises explicit selection,
protected-main freshness, immutable commit/tree binding and refusal of malformed
or changed observations without network or managed operations. It belongs to the
required EF70 strict project and canonical test shard 1. This new suite has no
historical measured shard timing; all existing test assignments are preserved.
The ordinary required producer checks and later actual seven-chain campaign
remain separate evidence.
