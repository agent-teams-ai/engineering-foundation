# Managed upgrade preserving the consumer Node 26 default

Date: 2026-11-26. Status: proposed implementation plan; owner outcome approved,
two independent plan-review rounds and implementation qualification pending.
Producer base: `fac03920e50ebde038ae415edeb7aa9e3d610ada`.

## Assigned outcome and boundaries

The owner explicitly asked to resolve the tooling conflict, use current compatible
versions and finish the remaining Extension Foundation E1 delivery. Preserve the
consumer's Node 26 default and never initialize TypeScript older than 7.0.2,
including an embedded compiler or comparison oracle. This instruction follows the
reviewed [central preparation checkpoint](https://github.com/agent-teams-ai/.github/blob/755c8515a5d106402a7e9e2cff621fb1fdc855cf/governance/evidence/docs-cohorts/docs-2026-11-25-stable32/record-review.md).
The earlier generation2 candidate remains inert historical preparation.

The existing Docs Protocol Agent Teams consumer-integration feature owns the
upgrade and its source observations. Repository Mutation remains the only writer.
Central owns published cohort qualification, lifecycle and enrollment; Extension
Foundation owns its tooling adoption and full checks. Get Modular's #254/#255
delivery is already complete and receives no additional implementation here.

Reuse the existing explicit profile3/Cohort2 to profile4/Cohort3 retained
controller from ADR-0070. This supports preparation, cold finalize and committed
rollback already. A new retained 2-to-2 family would duplicate those mechanisms.
The latest target profile4 already requires the preserved Node 26.11.1 pin, so it
needs no weakened target reader. The independently installed controller executes
under the existing exact Node 24.21.0; target activation executes under the actual
Node 26.11.1 and pnpm 11.20.0.

This is a bounded amendment to source admission and retained source verification,
not a general migration manager, runtime autodetection, package-manager override,
temporary pin rewrite or a consumer patch framework. Historical ADRs, schemas,
receipts, cohort records and immutable asset bundles remain byte-preserved.
Record the precise successor through the ordinary accepted-decision procedure
after plan review; a proposal or passing test is not publication or adoption.

## Observed prerequisites

- EF main is `65e03edd10cc08194cc4031f857aae302d4b9020`; its E1 research source
  `fa77630a9d4ba86aa98e45e5df709d9c9976b8a4` passed strict TS 7.0.2, nine
  deterministic tests and actual read-only GitHub observation. Later branch
  commits changed only its delivery-plan documentation.
- EF's Foundation 1.7.2 eagerly initializes API Extractor's TypeScript 5.9.3.
  Its current ordinary full gate cannot be reused as a permitted new execution.
- The installed adapter 0.3.2 and current adapter 0.6.2 refuse committed Node 26
  in profile3 even under an actual Node 24 process. The existing retained 2-to-3
  controller performs this source observation before staging.
- Current published coordinates are Foundation 4.0.0, Docs Protocol 0.6.7,
  Agent Teams adapter 0.6.2, Document Authoring 0.3.7 and Repository Mutation
  0.5.0. The official closure resolver observes 88 packages, exactly three
  roots and seven managed edges, with TypeScript 7.0.2 only and no executable
  API Extractor. Stack Toolchain 0.3.1 is separately published.
- Those five coordinates originated in release run 45279346093 attempt1,
  which failed later at the unqualified FMS 0.4.0 artifact. The later successful
  release reused their existing bytes; it is not a same-run success proof for
  their original mint. Current Central policy must not be relaxed to disguise
  that provenance. Use a normal forward Changesets release of a coherent
  five-coordinate tuple, with real successful publication evidence.
- Source and original restoration inventory already includes an unchanged
  `.node-version`. Committed rollback's current-target admission does not
  presently guard it when it is absent from mutation operations.
- Some retained-controller positive tests return after expected runtime refusal
  unless running on exact Node 24.21.0. Ordinary Node 26 test success therefore
  does not establish those positive branches.

## Implementation design

### Narrow source observation

Keep the ordinary profile3 reader, check/plan/apply commands and same-generation
upgrade behavior unchanged. Select the bounded source reader only through the
already explicit prepare request with source generation2, target generation3 and
a separately selected restoration proof. Compose the same application use case
with that reader; do not add another application implementation or public mode.

Reuse the existing contained stable-file, source Git/tree, physical-root,
package/lock, historical asset, policy and pending-state observations. Admit the
existing qualified legacy Node 24 pin or the exact preserved `26.11.1\n` image;
the preserved variant must equal the deterministic target pin. Observe actual
controller Node 24.21.0 independently. Wrong/missing runtime, unsupported pin,
symlink, dirty source, foreign managed bytes, stale authority and source drift
must refuse invalid initial source admission before staging. Reject a failed
selected runtime or package-manager preflight before package installation.
Re-observe source images and protected authority after staging and before
real-consumer publication. Drift detected after publication prevents completion
and follows the existing receipt-owned compensation/recovery rules; never claim
that earlier staging or publication effects did not occur.

The retained controller checks historical source data through existing pure
planners and asset projections. It never initializes the old Foundation CLI or
old compiler. Installed package identity, frozen lock/closure and source-byte
proof remain required. Do not describe this as successful execution of the old
installed CLI.

### Preparation, finalization and restoration

Retain the existing generation2-to3 preparation/proof family and its complete
source inventory. A preserved Node pin is a read-only guard; omit it from
Repository Mutation operations when its preimage equals its target. A no-op
write must not create receipt ownership or compensation authority.

Validate that guard at source observation, preparation scope validation,
finalization/resume and source restoration through the existing leases and
inventory checks. Strengthen committed-target selection to require exact target
pin bytes and the preserved source mode before inverse CAS. A newly committed
foreign pin must refuse before publication or package installation.

For preserved-host source restoration, compose an explicitly named retained
source verifier over the restored exact images. Use the same historical
projection/data checks as admission. Keep the legacy installed-CLI path and its
claims unchanged for historical sources where it is applicable. Preserve
authentic receipt ownership, cold lost-receipt behavior, authority refresh,
offline frozen installation and fresh current-target identity/ancestry checks.

Target stage, real plan/apply/check and activation continue to use the installed
target profile4 CLI and actual qualified target runtime. No target admission
exception or broad legacy reader relaxation is needed.

### Test execution and critical cases

Use the existing Git/RM controller fixtures and physical runtime routes. Add
tests only for these changed guarantees and credible failures:

1. An exact clean stable31 source with preserved Node 26 is admitted only by the
   explicit retained 2-to-3 prepare route. Ordinary legacy commands still refuse.
2. Preparation retains original pin bytes/mode and contains no pin mutation when
   target bytes are identical; all original/target bindings remain exact.
3. Wrong controller/target Node or pnpm fail their selected preflight before
   package installation; invalid source pin, dirty source or altered assets
   refuse initial admission. Source/authority drift during staging refuses
   before real-consumer CAS. Drift after publication withholds completion and
   preserves recovery evidence. Observe disposable installation, consumer
   publication and activation as distinct effects.
4. Actual forward publication, activation and target check pass with exact
   separately observed runtimes and real installed packages.
5. Stop a child after publication before activation; a new controller resumes.
   Repeat the existing lost-receipt case without inventing write ownership.
6. Failed activation compensates only an authentic full owned write receipt.
   The restored pin, package/lock images and unrelated Host files match exactly.
7. Original and later committed rollback pass; a separately committed changed
   pin or changed pin mode refuses before inverse CAS and install. Include a
   committed target with actual or representative EF Host integration changes:
   overlapping Host changes first refuse, their owner reverses them on the
   unmerged rollback branch, and a fresh current selection restores only managed
   files while preserving unrelated Host data.
8. Changed source/target image, stale HEAD/tree, wrong retained controller/build,
   mixed images and unavailable authority retain their existing refusing cases.
9. The retained source path demonstrably does not execute the old Foundation or
   compiler. Reuse the existing deny-only import guard, including realpath and
   alias checks and sticky failure when a denial is caught. Synthetic negative
   controls must prove denial before evaluation; never load TS 5.9 to test it.
   Rejecting an old compiler must not count as a successful full gate.

Run all new and affected positive recovery tests under actual Node 24.21.0 through
the existing selected executable route. Retain their Node 26 wrong-runtime
coverage separately. Log the positive scenario identities and execution counts;
an early-return refusal, skip or an absent test does not qualify recovery.

`Cold` means a new process using separately retained exact controller/kernel
builds and explicitly observed runtimes. Prepare and identify the required
package-manager/package caches deliberately; do not rely on a running controller,
in-memory ports or accidental ambient caches. Missing offline source-install
material leaves an honest failed/incomplete recovery state. Reversing bytes alone
is not completed restoration; there is no online fallback or old Foundation gate.
The compiler-load guard spans the observed operation and relevant children, and
any sticky denial fails that complete observation. Fault-point TEST ports prove
recovery semantics separately from real installed-package/CLI evidence.

Keep new maintained source/tests in ordinary `.ts`, the owning strict TS 7.0.2
projects and existing complete inventories. Use focused tests while editing,
then the complete exact head/base native `full-ci` matrix before producer merge.
Independent implementation review must cover both effects and evidence claims.

## Delivery sequence

1. Push this plan promptly, complete two independent review rounds and record
   corrections. Prepare the bounded successor ADR through the existing owner
   approval/baseline mechanism; user authorization is already recorded above.
2. Implement the source reader, retained verifier, pin guard and focused physical
   test route with existing owners. Use a single producer feature Draft PR and
   normal Changesets intent; include the fresh five-coordinate provenance
   recovery and an explicit FMS patch because its packed workspace dev pin
   changes with Foundation. Let the official planner derive downstream bumps;
   no dependency versions or release baselines are manually invented.
3. Run changed/fast/workflow checks, independent source review and requested
   complete native CI on final producer head/base. Resolve findings and merge
   through the ordinary guarded owner route; inspect actual merged-main checks.
4. Let the normal version planner produce the coherent release PR. Verify its
   exact graph, source identities and release-owned baseline promotion. Review,
   qualify and merge it normally, then wait for actual publication, provenance
   and public installation checks. No package is admitted from metadata alone.
5. Collect actual new versions/SRIs, registry signatures, provenance and complete
   compiler/runtime closure with existing Central helpers. Register and qualify
   the bounded generation3 cohort and EF canary enrollment through normal
   Central authority PRs. Preserve historical records and other consumers.
6. Retain the actually published external controller separately. Demonstrate
   forward preparation/finalization, cold resume and exact original/committed
   restoration in disposable EF copies. Only then perform the selected consumer
   transition on its own branch.
7. Adapt EF's Host-owned tooling to current Foundation quality v5 and supported
   Stack/FMS interfaces without dropping governed roots, tests or scripts.
   Preserve its Node 26 default and the original E1 code/evidence boundaries.
   Recheck the committed rollback case against this final Host integration
   shape, including owner reversal of overlapping fields before fresh selection.
   The earlier pre-Host rollback probe alone does not qualify this final state.
8. Complete EF's full ordinary gates, independent review, normal merge and
   actual-main checks plus a fresh online E1 observation. Finish the applicable
   Central canary/adoption observations using those actual merged-source proofs.

Existing unrelated producer PRs #458, #468, #469 and #476 are separate work.
Read their relevant evidence to avoid duplication; do not merge them merely to
make this feature green. Diagnose any actual prerequisite on its own merits.

## Estimate and alternatives

These are planning ranges for one experienced engineer, including focused
integration and review, excluding generated locks, immutable evidence, prose,
native toolchains and elapsed CI/registry waits. They are not deadlines.

| Route | Production/integration LOC | Test LOC | CI/helper LOC | Engineer-days | U | N | C |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Reuse retained 2-to-3 with preserved-source admission | 300–700 | 600–1,300 | 30–100 | 4–8 | 9 | 8 | 5 |
| Add a retained 2-to-2 source-preserving family | 600–1,200 | 1,000–2,000 | 60–160 | 6–12 | 6 | 8 | 8 |
| Permanently select Node 24 and use ordinary generation2 | 0–80 | 50–160 | 30–100 | 2–4 | 4 | 8 | 3 |

U is fitness for this owner-selected outcome, N is expected reliability within
that declared scope, C is implementation/maintenance complexity. These are expert
ordinal scores, not measured probabilities. Estimate confidence is 5/10.
EF Host integration adds approximately 120–300 maintained configuration/tooling
lines and 80–200 focused test lines, depending on actual published interfaces.

The selected first route preserves Node 26 and reuses Repository Mutation's
qualified writer and the existing retained-controller implementation. This
delivery qualifies the amended source, activation and restoration route. Its strongest counterexample is that a permanent Node 24 default
could use existing admission with less new producer code; that changes the
owner-selected outcome. The second route preserves generation2 but adds a
persisted protocol unnecessarily. No alternative grants a weaker compiler floor,
publication proof or consumer gate.

## Review and execution record

- Initial independent architecture and recovery audits found the target-reader,
  restored-old-CLI, unchanged-pin committed-rollback and Node 24 positive-test
  gaps. The design above includes them before implementation.
- Written plan review round1: two independent architecture/recovery reviewers
  reviewed exact source `b833b6f54a92aefeee221d8e3fd5a77785a20a63`. Both approved
  the direction and requested phase-specific drift guarantees, post-Host
  committed rollback, explicit cold/offline-cache semantics and precise
  qualification wording. Those four bounded corrections are incorporated.
- Written plan review round2: pending.
- Producer implementation, publication, Central qualification and EF adoption:
  pending; earlier E1 and central preparation successes remain separate evidence.
