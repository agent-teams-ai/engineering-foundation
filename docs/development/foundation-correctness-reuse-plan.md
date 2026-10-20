# Correctness and existing-tool reuse delivery

Status: reconstruction plan v1, awaiting independent review.

## Goal and source

Restore the previously selected correctness fixes and bounded reuse of existing
dependencies against `66984d7a71b469acfe557131f9a95295cc6b8553` and deliver them
through a reviewed pull request. The earlier unpublished candidate is unavailable;
its historical test results do not qualify reconstructed source. Existing fixes,
research and review notes are inputs to this work, not current approval receipts.

Keep Foundation's architecture-neutral development-tooling boundary. This work
does not change accepted ADRs, published schema versions, persisted protocols,
release authority, coverage floors or the complete test inventories.

## Selected implementation

### S1. Preserve runtime edges for inline type specifiers

Correct the Oxc adapter: an ordinary `import { type A }` or
`export { type A } from` is a runtime-bearing declaration. Declaration-level
`import type` and `export type` remain type-only. Preserve import/require and
source-phase semantics. Qualify the observable source graph and package export
selection, using the pinned TypeScript 7.0.2-or-newer parser as an independent
syntax oracle. Port the surviving earlier fix to the current source owners.

### S2. Reject invalid package export targets at the correct boundary

Keep the existing bounded pure matcher. Validate both raw package targets and
wildcard-substituted targets, including structural wildcard capture forms.
Preserve exact-target priority, import/require/types conditions, existing
targetless compatibility behavior, query/fragment handling and budgets.

An invalid array element may permit fallback under the current Node contract;
failure while finalizing a selected URL must not silently select a later array
element. Use independent Node resolution probes for disputed cases, plus real
graph fixtures for the admitted filesystem model. Do not substitute Node's
filesystem lookup for the capability's inspected source graph.

### S3. Coordinate atomic baseline replacement through Repository Mutation

Use the existing cooperative repository-root mutation lease around the final
preimage observation and atomic rename. Bind inspection and mutation to the
same physical root and target. Expose an existing Node evidence helper through
the existing public adapter entry if needed; do not deep-import another package
or create another lock protocol.

Create temporary bytes on the target filesystem with exclusive ownership.
Preserve refusal of unsafe targets, conflicting mutation evidence and stale
preimages. Release only owned temporary resources and retain all relevant
write, sync, close, cleanup and lease-release failures. An error after rename may
mean replacement already occurred; documentation and tests must not recommend
blind retries. The guarantee is cooperative serialization and atomic visibility,
not noncooperative filesystem compare-and-swap or power-loss durability.

Qualify the actual public baseline operation, competing cooperative writers,
preimage conflicts and process interruption/recovery. Permission refusal tests
must run under a process that actually respects those permissions.

### S4. Qualify the documented public documentation installation

Add a closed exact documented-version selector to the existing installer while
retaining its existing release/latest modes, archive integrity, signed source
and release identity checks. Keep the public CLI and MCP package profiles
distinct. Execute the literal quickstart in disposable npm and pnpm consumers:
preview, rejection of the wrong approved digest, apply, index and check.

Reuse the installer and runner that already own these operations. A published
installation qualifies the exact installed release, not unreleased candidate
CLI behavior; retain separate packed-candidate tests. Record actual external
availability failures without replacing a failed public command with a PASS.

### S5. Reuse the existing schema catalog for workspace configuration

Pass the existing narrow schema assertion dependency from composition to the
workspace dependency-declarations adapter. Validate raw v1/v2 configuration
before mapping it into the capability model. Preserve supported format behavior,
diagnostics, Bun parsing, cache ownership and budgets. Remove only the duplicate
Ajv construction, formatter and readers made unused by this path.

Different schema inspectors with distinct format or compatibility contracts stay
with their existing owners. This change adds no dependency and no new generic
validation service.

### S6. Reuse strict JSON parsing in the SDK record adapter

Use the existing public strict JSON parser and its declared error type. Preserve
duplicate-key rejection, object-root validation, subject identity and public
error behavior; translate syntax diagnostics at the adapter boundary and rethrow
unexpected failures. Keep canonical JSON and protocol digest implementations
separate where their contracts differ.

### S7. Preserve actual lint selection in the Node projection

Use the pinned Oxlint CLI as the selection authority when the isolated projection
lives below an ignored parent directory. Check source/projection file identity
before linting; only the three already-declared projected configuration files
may be normalized for this comparison. Frame paths and contents in the digest.

Keep selection, ignore policy, warnings, nested-config policy and lint budgets
unchanged. Preserve current `--paths` forwarding. Pass selected filenames safely,
with bounded argument batches where needed. Qualify real selection and actual
lint rejection in both source and projection; a zero-file run is not success.

### S8. Keep Git operations with their owning checkout

At the existing profile and command-dispatch boundaries, remove inherited Git
repository, worktree, index, object-store and injected configuration selectors
from ordinary children. Preserve author identity, authentication, transport and
the ordinary global Git configuration. Grant explicit source Git authority only
at the closed operation that owns source-history inspection.

Ensure source-owned checks run with the real source checkout as their Git cwd.
The changed-file check may inspect a disposable copy of the actual Git index;
it must not refresh or mutate the user's index. Qualify hostile inherited Git
selectors, source/projection separation, and real index bytes before and after.
Keep the already-declared workflow security configuration explicit and correct
the existing package-manager fixtures only where runtime ownership requires it.

## Integration and release boundaries

- Preserve the current FMS supported Foundation peer minimum, explicit lint
  argument routing, strict project includes and release Changesets fixture.
- New runtime source, tests and scripts use ordinary `.ts` and belong to the
  required strict project and relevant existing test inventories. Narrow fixes
  in historical `.mjs`/`.mts` owners do not trigger a repository-wide rename.
- Add normal Changesets for actual publishable package changes. Derive release
  impact from the current planner; do not repeat an obsolete FMS version bump or
  edit release-owned baselines and package versions manually.
- Retain meaningful negative controls. Change archive census or harness bounds
  only when independently measured source membership justifies the change,
  preserving the original rejection boundary and documenting its meaning.
- No new external runtime dependency is planned. Enhanced-resolve, oxc-resolver,
  Syncpack and canonical-JSON unification are outside this delivery. Optional
  Repomix/Lychee adoption and additional property tests require a concrete later
  task; they are not blockers for these fixes.

## Review and delivery

Run four sequential rounds with three independent planning critics, revising
the plan between rounds. Record source-backed objections and their resolution;
agreement alone does not qualify code. Stop speculative expansion and keep
remaining uncertainty attached to its specific implementation proof.

Implement independent concerns in separate working trees. Commit completed
pieces with the canonical owner identity and push them frequently. Integrate
them in a short-lived delivery branch and preserve reviewable commit boundaries.
Keep review records concise and bind final technical reviews to an exact commit.

Before opening the PR, run the repository's required Bun changed/fast/workflow
security commands and focused behavior checks. Before merge, obtain independent
technical review, fix material findings, and request the complete native full CI
for the final PR head/base with the user-authorized GitHub credential. Reuse that
head-bound matrix rather than also requiring an unrelated duplicate local full
verification run; run a local diagnostic when a changed risk is uncovered.

Record reviewer roles, exact reviewed head and verdict in the PR. Revalidate
the live PR, base, merge intent, complete native qualification and reviews, then
use the canonical organization owner merge guard with `--expected-head`.
Independently verify the merged PR and commit. GitHub Free's workflow-source
authority limitation remains explicit; a green check alone does not remove it.
