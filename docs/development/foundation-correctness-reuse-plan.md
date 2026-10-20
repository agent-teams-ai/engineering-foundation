# Correctness and existing-tool reuse delivery

Status: reconstruction plan v4 approved in four rounds. Implementation integrated;
independent implementation reviews and final native CI evidence are recorded in
[PR #418](https://github.com/agent-teams-ai/engineering-foundation/pull/418).

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
syntax oracle. Add a real Node loader side-effect or compiler-emission oracle:
agreement between two parsers is insufficient when both shared the original
mistake. Inline type names still do not bind runtime values. Port the surviving
earlier fix to the current source owners and keep the changed parser spike's
existing strict project on the required root typecheck route.

### S2. Reject invalid package export targets at the correct boundary

Keep the existing bounded pure matcher. Validate both raw package targets and
wildcard-substituted targets, including structural wildcard capture forms.
Preserve exact-target priority, import/require/types conditions, existing
targetless compatibility behavior, query/fragment handling and budgets.

An exact export key must preserve a literal `*` in its target; substitution is
specific to pattern keys. An invalid array element may permit fallback under
the current Node contract;
failure while finalizing a selected URL must not silently select a later array
element. Classify invalid package targets separately from fatal selected-URL or
request failures. Native implementation probes refined the initial plan:
ESM encoded-separator rejection inspects the URL pathname; Node's CommonJS
exports bridge inspects the complete selected URL, including query/fragment.
Preserve condition insertion order, null/undefined
continuation and exact-key priority. Assert the resulting filesystem target and
use independent Node import/require probes for invalid-target fallback, selected
encoded separators, literal wildcard targets and a selected missing file.
Use real graph fixtures for the admitted filesystem model. Do not substitute Node's
filesystem lookup for the capability's inspected source graph.

### S3. Coordinate atomic baseline replacement through Repository Mutation

Use the existing cooperative repository-root mutation lease around the final
preimage observation and atomic rename. Bind inspection and mutation to the
same physical root and target. Expose an existing Node evidence helper through
the existing public adapter entry if needed; do not deep-import another package
or create another lock protocol.

Create an exclusive sibling temporary in the baseline parent. Retain the root,
parent and temporary identities through final observation, rename and cleanup;
refuse a replaced temporary without deleting another writer's bytes.
Preserve refusal of unsafe targets, conflicting mutation evidence and stale
preimages. Inspect and retain existing common mutation evidence before effects
or release. Existing common evidence rejects promotion before rename and retains
the barrier; inspect again before release. The root lock's identity-verified
terminal retirement records are permitted evidence, distinct from leaked ADR
temporaries or active locks. The existing evidence-retention helper does not itself verify the
physical root: use the public mutation observation or an explicit bound identity
check as well. Release only owned temporary resources and retain all relevant
write, sync, close, cleanup and lease-release failures. An error after rename may
mean replacement already occurred; documentation and tests must not recommend
blind retries. The guarantee is cooperative serialization and atomic visibility,
not noncooperative filesystem compare-and-swap or power-loss durability.

Qualify the actual public baseline operation, held root leases, preimage
conflicts, root/temporary substitution and process interruption/recovery.
Cooperative contention may safely reject; the root lease does not promise
queued writers. Fault cases cover pre-rename write/sync/close and owned cleanup,
plus post-rename parent-directory sync, cleanup and release uncertainty without
adding a durability claim.
Permission refusal tests
must run under a process that actually respects those permissions.

### S4. Qualify the documented public documentation installation

Add a closed exact documented-version selector to the existing installer while
retaining its existing release/latest modes, archive integrity, signed source
and release identity checks. The maintained
`docs/reference/open-source-docs-protocol.md` owns the documented coordinates;
reject missing/conflicting coordinates. Exact documented releases need not equal
the registry's current latest tag; retain that requirement in the current
release/latest path. Keep the public CLI and MCP package profiles
distinct. Execute the literal quickstart in disposable npm and pnpm consumers:
init preview/apply, new-document preview/apply with its own observed digest,
rejection of wrong approved digests with unchanged consumer snapshots, the
returned manual link added to its named index, and final check. Admit only the
known fenced commands/argv and the installed documented binary; do not build a
general shell interpreter. Preserve four npm/pnpm docs-only/MCP-pair consumers
and the MCP read-only checks. Windows' existing read-only observation does not
qualify a POSIX quickstart, nor does importing an installed private renderer.

Reuse the installer and runner that already own these operations. A published
installation qualifies the exact installed release, not unreleased candidate
CLI behavior; retain separate packed-candidate tests. Record actual external
availability failures without replacing a failed public command with a PASS.

### S5. Reuse the existing schema catalog for workspace configuration

Create the existing scoped schema catalog in workspace feature composition and
pass only its narrow assertion dependency to the filesystem loader. Keep the
existing public construction signature and make the parser a pure mapper.
Validate raw v1/v2 configuration
before mapping it into the capability model. Preserve supported format behavior,
diagnostics, Bun parsing, cache ownership and budgets. Remove only the duplicate
Ajv construction, formatter and readers made unused by this path.

Retain YAML-before-schema order, exactly the selected v1/v2 schema read, thrown
reader identity, the existing `SCHEMA_INVALID` phase, frozen settings and the
assembly-cycle rejection. Do not widen an adapter's dependency allowance to
instantiate the catalog or import a top-level singleton.

Different schema inspectors with distinct format or compatibility contracts stay
with their existing owners. This change adds no dependency and no new generic
validation service.

### S6. Reuse strict JSON parsing in the SDK record adapter

Change only the owning `consumer-integration/adapters/strict-json-record.ts`
adapter and its callers' qualification. Use the existing public strict JSON
parser and its genuine declared error type. Preserve
duplicate-key rejection, object-root validation, subject identity and public
`ConsumerJsonInputError` name plus exact duplicate/root/default-subject messages.
Malformed syntax receives a subject-specific syntax diagnostic. Translate at
the adapter boundary and rethrow
unexpected failures. Keep canonical JSON and protocol digest implementations
separate where their contracts differ.

Register the exact caller under the already-admitted ADR-0053 consumer profile;
keep the parser primitive and accepted ADR bytes unchanged. Qualify nested and
escaped duplicate keys, malformed syntax and precedence, all nonobject roots,
subjects, valid equal keys in separate objects, unexpected/impostor failures
and a real cohort/profile/manifest caller.

### S7. Preserve actual lint selection in the Node projection

Use the pinned Oxlint CLI as the selection authority when the isolated projection
lives below an ignored parent directory. Check source/projection file identity
before linting; only the three already-declared projected configuration files
may be normalized for this comparison. Frame paths and contents in the digest.

Compare actual source/projected `--debug files` selections. Cover the dispatcher
full/file routes and the existing quality-session owner. Keep each configuration's
intentional ignores, warnings, nested-config policy and lint budgets
unchanged. Preserve current `--paths` forwarding. Pass selected filenames safely,
with bounded argument batches where needed. Qualify real selection and actual
lint rejection in both source and projection; a zero-file run is not success.
Reject added, missing or changed non-generated projected files after creation;
checking only the source digest against an old receipt is insufficient.

### S8. Keep Git operations with their owning checkout

At the existing profile and command-dispatch boundaries, remove inherited Git
repository, worktree, index, object-store and injected configuration selectors
from ordinary children. Preserve author identity, authentication, transport and
the ordinary global Git configuration. Grant explicit source Git authority only
at the closed operation that owns source-history inspection.

Keep `check:changed` source-owned: its Git collection, consumer and workflow
policy use the actual source checkout and source manager. If reached through a
Node-profile launcher, explicitly route it to that source-owned operation and
require its source dependencies; do not call it Node-projection qualification.
Other Node-profile tools retain their validated projection/configuration inputs.
Source-history leaf operations such as the release-owned-files guard inspect
the real source cwd; ordinary child fixture repositories get no inherited source
Git authority. Never pair a source Git directory with a projected worktree.

The changed-file check may inspect one owned disposable copy of the actual Git index;
it must not refresh or mutate the user's index. Qualify hostile inherited Git
selectors, source/projection separation, and real index bytes before and after.
Disable optional index locks, clean the owned copy and include linked-worktree
and foreign-index controls. Preserve transport and identity in those controls.
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
  Account explicitly for any additive Repository Mutation `./node` public export
  and its API/release classification, plus changed Foundation and Docs adapter
  packages. A release-owned baseline is not a shortcut to API qualification.
- Retain meaningful negative controls. Change archive census or harness bounds
  only when independently measured source membership justifies the change,
  preserving the original rejection boundary and documenting its meaning.
- No new external runtime dependency is planned. Enhanced-resolve, oxc-resolver,
  Syncpack and canonical-JSON unification are outside this delivery. Optional
  Repomix/Lychee adoption and additional property tests require a concrete later
  task; they are not blockers for these fixes.

### Archive census requalification

The full CI run `39401529327` rejected the actual Foundation npm archive at its
first member above the qualified 2,712-entry limit. Before changing that census,
independent clean builds and npm 11.19.0 archives measured the approved release
base `66984d7a71b469acfe557131f9a95295cc6b8553` and integrated source
`daded1d9dd2fa8bf1f69cafe551d14b095c95d3b`. npm's member lists and an independent
tar reader agree on 2,712 and 2,720 regular files respectively, with no removed,
directory or special members. The complete added set is `.js`, `.js.map`, `.d.ts`
and `.d.ts.map` for `architecture-decision-baseline-replacement.ts` and
`git-index-snapshot.ts`. Git source membership independently accounts for the
same increase: 664 to 666 modules, four emitted artifacts each, plus 56 unchanged
manifest-selected files outside `dist`.

The Foundation-only census is therefore exactly 2,720 entries. Its regression
requires the complete built inventory and all eight added artifacts, and rejects
one additional member through both listing and compressed-archive inspection.
Other packages retain 2,500 entries. This requalifies measured source growth;
it adds no spare entry allowance and changes no byte, member, portability,
allowlist or special-entry protection.

## Review and delivery

| Round | Reviewed version | Dependency/schema critic | Mutation/JSON critic | Installation/tooling critic |
| --- | --- | --- | --- | --- |
| 1 | v1, `4218ef3e` | Changes requested: loader oracle, export failure boundaries, schema composition | Changes requested: physical identity, failure ownership, JSON compatibility | Changes requested: exact documented release, source/projection ownership, real lint selection |
| 2 | v2, `f46bdfd3` | Approved | Approved; clarify retained terminal evidence and parent-directory sync | Approved |
| 3 | v3, `985ced4b` | Approved | Approved | Approved |
| 4 | v4, `dbe234cf` | Approved | Approved | Approved |

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
