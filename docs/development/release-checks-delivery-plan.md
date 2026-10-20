# Release candidate checks delivery

Status: accepted after I1-I3 and C1-C3; implementation in progress. The owner authorized this bounded
delivery on 2026-10-20 after the release-tooling research, with three sequential
plan-improvement rounds followed by three independent critical-review rounds.
Their actual findings and dispositions are recorded in
[the plan review record](../research/release-checks-plan-review.md).

## Outcome and scope

Deliver one architecture-neutral, deterministic development library,
`@agent-teams/release-checks`, in `packages/release-checks`. It verifies the
relationship between accepted release inputs, the exact existing engine plan,
and the independently observed generated candidate. Changesets remains the sole
version and dependent-propagation engine. Foundation source-builds and adopts
the library; Get Modular and node-or-bun adopt its qualified exact npm version.

Finish the assigned delivery through reviewed owner PRs, final native CI,
merges, the existing bootstrap/publication protocols, registry readback and
installed-consumer verification. A fresh run in the existing disposable TEST
repository `agent-teams-ai/ci-runner-sandbox-20261005`, using its existing
`@agent-teams/npm-publishing-canary` namespace, exercises
changeset -> generated version/changelog -> owner PR -> review/CI -> merge -> npm
-> installed consumer -> latest/tags/releases. Keep the three real consumer
adoptions separately evidenced; one canary alone does not establish them.

There is no universal release manager, new repository, monorepo migration,
alternative version engine, prerelease/maintenance expansion, preview registry,
new permanent secret, LLM service, background agent service, plugin registry or
generic workflow facade in this delivery. Accepted ADR bytes, repository
protection, Actions PR creation/approval=false and existing publisher authority
remain unchanged. A new additive admission ADR records the independent package.

## Current source and instruction baseline

Re-read these refs before an affected checkpoint and qualify any intervening
delta. Never relabel earlier CI or review as evidence for a new head/base.

| Owner | Preflight source | Retained choices |
| --- | --- | --- |
| Foundation | `bbaf422dae36f0aa3ed9234a197aef076c64c63e` | Changesets 2.31.1/action 1.9.0; Bun 1.4.3 source and isolated pnpm 11.20.0 projection |
| Get Modular | `ddf1e0b0053f546f12ca70190b237b4f7e78d09d` | Changesets 3.0.2; pnpm 11.20.0; existing Foundation 1.10.0 pin |
| node-or-bun | `3e6a1c44195680761787e4377fc560dd0f22e223` | npm/package-lock authority; public root 0.2.2; exact Node/Bun qualification |
| Shared npm publisher | `ff94f77116923d7842a37a8004a5f4e31d65201e` | Delivered publish/promote pin retained by both consumers |

Foundation's new main contains the reviewed development-tool refresh from
`be70ad0`; it is part of the accepted starting source, not a dependency upgrade
in this delivery. Follow each repository's AGENTS and the current organization
Engineering Quality Standard. New maintained source, scripts and tests use
ordinary `.ts`, strict TypeScript 7.0.2 or newer, the actual required typecheck
route and complete test inventories. Narrow edits of existing scripts do not
require unrelated filename or architecture migrations.

## Ownership and minimal contract

### Package and Host boundary

The independent package owns one normalized contract, runtime input validation,
release-specific pure comparisons, deterministic diagnostics and common
conformance cases. It has no runtime, peer or optional dependency, Foundation
dependency, credentials, filesystem/process/network API, Changesets DTO,
package-manager object or consumer architecture vocabulary. Its only development
dependency is the repository's exact catalog TypeScript compiler, using the
existing clean-stage build and compiler custody mechanism. Consumers do not
install that development toolchain. A separate package makes it usable
without installing the Foundation compiler stack; its source location does not
create a dependency on `@agent-teams/engineering-foundation`.

Each Host owns Git/filesystem observation, the exact engine invocation and raw
plan normalization, workspace inventory and file classification, source/PR/CI
authentication, changelog/history/API policy, locks, generation sequence and
owned cleanup. Existing workflows and the active assigned owner-agent own PRs,
reviews and merges. Existing publishers own registry effects and recovery.
Source-built Foundation imports the built workspace entrypoint; consumers use
the public package API as a development dependency, never a product runtime
dependency or an import through the Foundation root.

Use ordinary functions and immutable records. Start with one public operation,
`checkReleaseCandidate({ expected, observed })`, and the concrete types needed
by callers. Runtime malformed inputs return a coded rejected report. No CLI is
required by the three API consumers; do not create one without a concrete need.
Public conformance data may use one deliberate testing entrypoint if required
for installed consumers; avoid exports that only mirror private helpers.

### Expected and observed facts

Expected inputs come from the accepted source before generation:

- immutable source identity/digest; exact engine identity and config digest;
- complete classified public/private workspace inventory, including any private
  root, and accepted full manifest semantic records;
- intent identities, paths and source digests, with explicit requested packages;
- frozen normalized official plan with exact old/new versions, direct intent
  links, dependent releases, and explicit consumed-intent expectation;
- consumer-owned exact permitted output paths, kinds and content authorities.

Public/private visibility is separate from version eligibility. The Host maps
its exact engine/configuration into qualified versioned, unversioned or ignored
package facts, or an equivalent complete per-request disposition. The core
requires every eligible pending requested package to have its corresponding
official direct plan link; it does not implement the engine's eligibility rule.
Retain the full raw intent inventory while distinguishing pending from already
applied or otherwise retained intents under existing Host selection. Existing
Foundation prerelease consumption can record an intent in Host-validated
metadata while retaining the source file. Keep that effect in the complete diff
and preserve the current prerelease content guard; add no new prerelease lane.

Observed inputs are read independently after generation:

- re-observed original input binding, separate from the new candidate head/tree;
- all classified manifest identities and full before/after semantic records;
- consumed intent identities and original digests;
- the complete candidate diff with path, change kind, before/after hash and
  type/mode, with absence represented explicitly.

Do not derive observed paths or manifests from the planned release list. The
Host enumerates the whole candidate tree and includes or refuses untracked
generation outputs. Normal output changes do not count as source-input drift:
the binding refers to the immutable original input snapshot and the relevant
re-observed original inputs; candidate head/tree is recorded separately.

Bind the actual resolved source root, Git directory, processed source commit,
exact CLI installation/entrypoint and engine/config/input bytes used for both
planning and versioning. Capture version-route identity after the pinned
action's admitted reset to processed main. Its prescribed branch movement is
permitted; a foreign root/Git directory or changed processed commit, engine or
config rejects. Re-observe actual execution inputs and source authority rather
than copying expected fields or merely re-reading historical commit bytes.
Account for intended output mutations through the candidate relation. Extend
the existing `scripts/npm-package-bootstrap-release-plan.mts` official-plan
collector so bootstrap policy and candidate checks use the same frozen plan
projection for a candidate. Host-owned in-process or short-lived evidence is
sufficient; the library owns no persistence mechanism or second version oracle.

Separate the portable candidate binding from physical execution custody.
Repository/source identity, processed commit and exact engine/config/input/plan
content identities can be compared across authenticated checkouts. Actual
repository root/Git directory, engine working directory and resolved installed
entrypoint belong to Host-local execution evidence and are re-observed within
the planning/versioning execution they attest. Independent legitimate PR
qualification need not use identical absolute paths. That portability never
permits a foreign-root/Git-directory or substituted engine within one bound
execution.

### Enforced invariants

1. Inventory identities, manifest paths and intents are unique and unambiguous;
   every referenced package/intent is admitted. Private packages remain visible.
2. Preserve the complete normalized plan inventory, including explicit `none`
   and absent-version records. Actual version edits equal exactly the entries
   requiring a version change; every old/new value or explicit absence matches
   observation. An unchanged record need not modify a file. Ignored/private
   intents are consumed only when the qualified adapter explicitly expects it;
   presence in `plan.changesets` alone does not determine consumption. No second
   SemVer or dependency-range computation exists.
3. Planned direct and dependent releases have the engine's actual intent links;
   every eligible pending requested package is covered reciprocally. Consumed
   intent identities/digests/effects match the qualified engine behavior,
   including existing retained-file prerelease bookkeeping.
4. The full diff has admitted paths, kinds and file types/modes. Classification
   never authorizes unrelated source, workflow or authority changes.
5. Full manifest content is equal except the exact planned version. No generic
   allowed-kind label permits a scripts/exports/dependencies mutation.
6. Source, inventory/policy, engine/config, intents and frozen-plan bindings
   remain consistent. A stale candidate is regenerated from current source.
7. Empty release plans admit no version or intent-consumption drift. The Host
   ends a real no-release state without invoking version or waiting for a branch
   or PR. When an actual release exists, qualified empty housekeeping intents
   may be consumed with it; retain ignored and non-versioned private intents.
8. Reports have a stable passed/rejected union and deterministic case-sensitive
   package/path/diagnostic ordering. A passed report does not authenticate its
   caller, establish bump adequacy or authorize merge/publication.

Version-only manifest comparison is the admitted v1 scope. Pinned Changesets
2.31.1 and 3.0.2 preserve the symbolic workspace ranges used by Get Modular.
Foundation retains its stricter policy and the existing FMS peer floor.
Qualify actual pinned execution before export. A required unsupported rewrite
rejects until its specific owning decision/evidence exists; do not invent a
generic rewrite API or obtain nonexistent edit operations from `status` output.
Preserve explicit v3 `none`/private/ignored records and qualify their meaning;
never silently drop them, guess versions or equate all listed intents with
consumed files.

## Semantic reuse and conformance map

| Rule | Existing owner | Delivery treatment |
| --- | --- | --- |
| Full manifest equality except version | `scripts/check-release-pr-files.mjs` | Transfer the pure mechanism and remove the superseded comparison with parity evidence |
| Catalog identity and observed changed-manifest coverage | Same Host | Core checks normalized facts; Host retains actual independent observation and inventory authority |
| Consumed intents/intended package coverage | `scripts/check-release-pr-freshness.mjs` | Transfer matching normalized mechanism where equivalent; preserve its content/prerelease interpretation |
| Exact engine-plan/result versions and sets | New common guarantee | Prove with independent expected fixtures; do not describe as existing DRY deletion |
| Normalized input binding and full-diff constraints | New common guarantee | Compose with existing trusted Host source/PR/CI checks |
| Changelog/history/summaries, locks, API baselines, archive custody | Existing repository owners | Retain their named checks; remove no protection merely to reduce similar loops |

P1 records and migrates every production callsite of a transferred rule,
including both release PR guards and
`scripts/public-api-native-migration-version.ts::verifyVersionWorkflow` before
existing baseline mutation. Apply the core at the existing generation,
pre-mutation and current-head/base PR qualification boundaries with independently
observed facts. Expected plan/input facts come from accepted source or its
trusted head-bound generation evidence, never from candidate versions. Remove
superseded equality/coverage branches in that same checkpoint. Existing helpers
retain their Host content/prerelease/source rules; they neither manufacture a
synthetic full checker request nor retain a second manifest comparison.
Qualify tampering before baseline mutation and tampering introduced into a
release branch after generation, while retaining existing Host fixtures.

Foundation's existing release profile, release PR section helpers, authentic
Changesets/lock fixtures, catalog-derived qualification and bootstrap workflow
remain the owners to extend. Use existing `ci-input-proof` only in a Host seam
where unchanged-membership input comparison actually fits; it is not a release
diff model and is not a new dependency of this leaf.

P0 must confirm the residual shared mechanism and real consumer scope. If no
useful shared invariant remains after evaluating the existing tools, cancel
new package admission and retain the established Hosts. Expected reuse is a
valid admission reason; three pre-existing copies are not required.

## Delivery checkpoints

### P0 — preflight and reviewed plan

Complete the exact source/engine/semantic maps, actual pinned fixtures, package
name/namespace check, required ownership/feature/API/release inventories and
toolchain readiness. Record CMS/FMS pin deltas relevant to this tooling scope;
do not upgrade their content pins or migrate unrelated capabilities.

Complete improvement rounds I1-I3 in sequence, applying each before the next.
Then complete independent critic rounds C1-C3 in sequence on the revised plan,
disposing each substantive finding before the next. Persist plan revisions and
findings on the feature branch. Implementation begins only after these rounds;
reversible environment setup and source reads may proceed meanwhile.

Before merging public admission, confirm the existing bootstrap path is
operable: required owner/provider access, exact workflow/environment route and
availability of its interactive step. Readiness is not early configuration,
bootstrap execution or a claim of publish permission. Create short-lived
provider credentials/configurations only in their proper P3 phase.

The observed absent public namespace, disabled bootstrap enablement and empty
protected-environment secrets are expected before bootstrap. GitHub owner/admin
access and the existing reviewer route are qualified; local npm `ENEEDAUTH` is
only a local-session observation, not evidence about hosted OIDC. Before P1
merges, establish that the authorized npm maintainer can perform the existing
interactive one-package granular-token and environment-review step when P3 is
ready. Record the available maintainer/reviewer identity and qualified existing
environment route without creating a token or enabling bootstrap. If this
interaction is unavailable, finish implementation/review preparation and keep
public admission unmerged.

Revalidate the existing TEST repository, head, workflow, package and access,
and qualify the narrow missing full-chain extension before P1 admission. Its
`npm-publication-e2e.yml` and prior successful run `39409882120` establish only
the publisher lane, not Changesets generation or an owner PR chain.

### P1 — Foundation package and real self-adoption

Create the pure package at `0.0.0` with its initial minor Changeset, source,
strict project, curated exports, documentation and conformance tests. Generate
the create-only native initial public API baseline from actual built output.
Add a new admission ADR as one independent node in the existing package DAG;
preserve all accepted predecessor bytes and historical migration packets.

Update every current admission projection atomically: publishable catalog,
public API and repository-security inventories, root TS references, source and
feature ownership, compiler/coverage scope, complete Linux/Windows test
inventories, and candidate bootstrap profile with approval null. Reuse derived
registry membership and package order instead of adding another catalog.
Regenerate Bun source and isolated pnpm projection locks through their owners.

Integrate Foundation's actual version route: freeze the official plan before
`changeset version`, preserve build/API-baseline/lock order, independently
observe its result, run shared checks plus existing content/history checks, and
refuse commit/push when rejected. Remove only transferred duplicate mechanisms.
Add packed import/conformance and installed behavior through the existing
hermetic Verdaccio registry qualification owner; catalog membership alone is
not installed-consumer evidence. This uses the existing test facility, not a
new preview registry. Public npm installation remains a distinct P3 proof.

Run required changed/fast/workflow-security and focused gates, independent
technical review, then request the complete native final-head/base CI matrix.
Merge by the canonical owner guard after revalidating current PR/source facts.

The accepted intermediate state is explicit: merged public admission blocks
ALL ordinary Foundation publication until the new namespace completes P3.
Private staging, missing catalog entries and false historical/bootstrap states
are not substitutes. Existing unrelated Foundation packages cannot publish in
this window. Prepare independent P2 work early where possible to shorten it.

### P2 — independent consumer preparation

Prepare Get Modular's API wrapper, exact Changesets v3 version-branch route and
conformance on the qualified candidate tarball in a disposable TEST checkout.
Keep its current Foundation pin, eight-capability configuration and native
migration packet. Changes to independent release tooling do not adopt a new
Foundation capability or production module.

Prepare the real consumer changes with the intended exact registry coordinate,
but do not merge a dependency on a version that does not yet exist. Prepare the
narrow retained-input successor and its rejection evidence before adoption.

### P3 — existing namespace bootstrap and supported release

Use the existing ADR-0044 protocol only. Retain the exact Ubuntu pinned
Node/pnpm writer archive, package tree and SRI; local platform packing does not
replace writer evidence. Review those identities and approve the existing
catalog profile only after exact evidence exists. Complete exact protected-main
push CI for the approved-profile owner merge before the timed provider step and
bootstrap dispatch. A catalog-only approval does not require different-platform
re-packing: new writer evidence is needed only when the bound package tree or
archive changes.

Use the existing one-package short-lived bootstrap credential and protected
environment when required, with no permanent token. Preserve the one-attempt
publisher, signature/attestation/provenance, allowed initial tags, deprecation,
quarantine and uncertainty reconciliation rules. Configure the normal Trusted
Publisher after bootstrap, revoke/remove the temporary credential and disable
bootstrap enablement as required by the current protocol.

Check current npm permissions: direct publishing and staging are different
actions; dist-tag permission is relevant only to a route that actually moves
tags. New configurations have a bounded first-publication window. Keep
Foundation's direct final-tag route and the consumers' separate promote route.
No provider configuration or token exchange alone proves publication authority.

Prove the bootstrap postconditions and GitHub prerelease before the normal
Trusted Publisher/credential-cleanup continuation. The push-only `release.yml`
can have correctly failed its baseline guard before namespace creation;
bootstrap completion emits no new release trigger. Re-read current main and
that run's processed source after cleanup. Rerun the existing failed
current-input release phase only if those commits still match exactly. If main
advanced, use the owning current-main push/run and regenerate as required; do
not invent a dispatch endpoint or qualify a stale generation.

Continue the existing qualified generated branch -> inspected owner-created or
adopted PR -> current-input attestation/CI -> canonical owner merge flow to
derive and publish supported
`0.1.0`, or the exact version generated from the actual accepted initial intent.
Prove registry archive/source/SRI/provenance, installed public import/conformance
and intended tag. This public npm proof is distinct from P1's hermetic registry
qualification. After the supported publication, complete the existing catalog
transition to historical state through its reviewed owner change.
Never upload bootstrap bytes again blindly or claim TEST as production release.
P3 qualifies the package already admitted by P1; it does not admit it twice.

### P4 — Get Modular registry adoption

Adopt the exact supported version in the existing pnpm catalog/development
dependency and regenerate its authoritative lock. Keep current Foundation and
publisher pins. Route the checker and repository-owned changelog/content guard
through an appropriate existing CI owner, preserving the complete required set.

Accept only the reviewed release-only retained-input addition. Current policy
compares all devDependencies, workspace catalog and full lock, so new tooling
requires an explicit successor. It must retain original source/package-tree
bindings and archive bytes and reject compiler/build/pack or unrelated graph
drift. Do not exempt all development dependencies or strip arbitrary lock data.
If isolation cannot be proved, adoption stays pending the owning migration.

The existing real Resources patch intent may produce a normal new release;
the four unchanged public packages still require retained-input qualification.
Execute actual generated candidate, required CI/review/owner merge and the
existing manual exact-main publication/reconciliation path. A skipped automatic
release job is not reconciliation evidence. Preserve exact retained archive SRI.

### P5 — node-or-bun adoption and truthful metadata release

Use a separate small owner PR. Choose and qualify an exact Changesets pin for
the current npm-managed single-package repository; add its config, version
route, pure API integration, instructions and required TypeScript tests.
The independent leaf has no Foundation edge and does not change node-or-bun's
existing prohibition on a Foundation dependency or its npm authority.

Its root manifest is part of the public tarball. New devDependencies/scripts
therefore change published inputs. Follow the existing metadata-only patch
precedent with an honest owning Changeset describing this package change; let
Changesets generate version/changelog. Do not fabricate a runtime change or
bump unrelated packages merely to obtain a publication.

For the npm-managed route, freeze the official plan, run the same qualified
Changesets CLI, synchronize `package-lock.json` through
`npm install --package-lock-only --ignore-scripts --no-audit --no-fund`, then
independently observe/check the complete candidate before commit/push or PR
qualification. The lock guard admits only the matching root version metadata
changes and rejects dependency graph or unrelated lock drift. Changesets alone
decides the version; no hand bump or general lock exemption is added.

Keep the original exact-source CI archive, existing Node/Bun/Node-in-Bun installed
qualification, shared publisher pin, readback and promotion. Same-version
reconciliation is admissible only if actual archive bytes/SRI match. If the
owning classification produces no release, record release proof as pending;
do not count an automatic skip, substitute an old archive under a new source,
or create a new retained-artifact subsystem to preserve the version number.

### P6 — fresh complete canary and fleet evidence

Reuse `agent-teams-ai/ci-runner-sandbox-20261005` and its existing canary namespace
after revalidating actual state. Fresh means a new accepted source/change intent,
generated version and observed run, not a new repository or package bootstrap.
Extend its existing publisher lane narrowly with actual Changesets intent,
generated version/changelog, shared candidate check, owner-created PR,
independent review and exact CI, canonical owner merge, installed consumer,
intended npm tag and applicable Git tag/release reconciliation. Execute one
accepted fresh publication and an exact-archive replay without duplicate
effects. Reuse current publisher
negative/receipt tests; add only the missing assertion that candidate rejection
cannot bypass the existing publication admission. Demonstrate that negative
without merging or publishing the rejected candidate.

The nested npm canary uses the same qualified order: official plan, Changesets
version, npm lock-only synchronization, then whole-candidate checks. Its P0
probe proved that Changesets 3.0.2 leaves both root lock version fields stale
until npm synchronizes them. Keep that metadata-only lock relation enforced.

The TEST target currently has unprotected main. Preserve its protections and
inspect actual review/CI/merge facts; it does not prove protected-branch
enforcement. Claims about production protection and complete native gates need
the separate evidence from the three real repositories.

For each real repository record adopted source, generator/checker execution,
content guards, final review/CI/merge, package coordinate/SRI and the applicable
publication or reconciliation/installed proof. Verify actual production pins
and latest and document only real remaining operational prerequisites.

## Owner continuation, concurrency and failure recovery

Retain existing generation/publisher concurrency groups and exact source/run
binding. One active assigned owner-agent continues the authorized task; no
always-on behavior is claimed outside that assignment.

- No-release ends successfully without waiting for a PR.
- Bootstrap completion resumes the exact-current failed push-only release phase
  after cleanup, or the owning newer-main push/run if source advanced.
- Real generation failure preserves diagnostic evidence and produces no PR.
- Expected Actions PR-creation denial with a qualified branch leads to an
  inspected owner-created/adopted PR. Re-read main versus processed source and
  rerun only the documented current-input phase. After regeneration re-read the
  complete candidate/head and owner PR; stale receipts do not qualify it.
- Authoritative generation runs in its owned workflow checkout. A partial
  version/baseline/lock failure preserves diagnostics, prohibits push/publish
  and recovers by the existing clean-current-main regeneration route. The
  primary user checkout is never a cleanup target.
- After timeout or uncertain publication, read runs/registry/effect receipts
  before choosing the documented recovery. Do not retry upload from a single
  404 or transport error, overwrite a version, or roll back a newer latest tag.
- Partial publication retains its exact package outcomes. Missing Git tags or
  releases are reconciled separately and do not cause a second npm upload.

The merging agent records independent reviewer role, reviewed exact head and
verdict in the PR, revalidates full native evidence/current head/base/owner and
uses the canonical organization owner merge guard with expected head. Existing
Actions integration limitations remain explicit. No self-attested CI review
status, protection change, bot PR or additional routine approval ritual is added.

## Minimum sufficient verification

| Subject | Meaningful proof |
| --- | --- |
| Pure contract | Handwritten direct+dependent positive fixture and targeted negatives for exact versions, unknown/duplicate identities, intent coverage/digest, stale binding and unexpected files |
| Content guarantees | Planned version plus hidden scripts/exports/dependency edit rejects; private manifest changes remain visible; allowed labels cannot bypass content checks |
| Observation | Full independently observed diff includes missing/untracked/type/mode changes; before/after facts agree with manifests and consumed intents |
| Engine adapters | Actual pinned v2/v3 execution covers symbolic workspace ranges, existing peer behavior, private-versioned/private-unversioned/public-ignored cases, pending versus retained intents, no-release and an unchanged record beside a real release; fixture literals are independent expected values |
| Foundation integration | Existing authentic release/lock fixture, source-built adoption, content/history guards, strict typecheck, packed and hermetic-registry imports in P1, distinct exact public npm import in P3 |
| Execution binding | Changed actual processed HEAD/root/Git authority or substituted CLI/config within one bound execution rejects despite unchanged supplied expected JSON; portable source binding admits independent legitimate checkouts; retain existing foreign-Git-selector negatives |
| Failure recovery | Existing clean-current-main and partial version/baseline/lock failure tests; no partial push or dirty replay |
| Get Modular | Exact leaf+lock addition accepted only by reviewed successor; compiler/build/unrelated graph drift rejected; retained archives keep exact SRI |
| node-or-bun | Real generated metadata patch, exact npm root-lock version synchronization without graph drift, and complete Node/Bun installed consumer qualification; unchanged byte requirement remains enforced |
| Operations | Required exact-head/base native CI and independent review, existing uncertain/partial/rollback publisher tests, one fresh full owner-PR chain in the existing TEST target and safe replay; separate real-repository protection evidence |

Use each repository's documented focused, changed, fast and final native gates.
Do not add a test-count goal or repeat a full local suite when the required
current CI already covers that risk. Type stripping is not typechecking.
The expected kernel size is only an estimate; report actual production logical
LOC separately from adapters/tests/docs after implementation.

## Recovery and completion record

Before public P1 admission the prior qualified publisher remains available.
After merged P1, recover the publication hold by completing existing bootstrap
or by a coherent reviewed revert of the package, self-adoption and every
admission/baseline/lock authority. Removing a wrapper or TEST files is
insufficient. Published bytes and history remain immutable; later repair uses
the existing reconciliation or next truthful release.

Retain source refs, plan and actual diff identities, check reports, independent
reviews, run IDs, archive SRI and installed consumer results in maintained
delivery records. Exclude credentials, login URLs, cookies and tokens.
Mark source implementation, package qualification, publication and each
consumer adoption separately. The program is complete only when all three real
routes, the fresh canary, applicable recovery proof and documented active-agent
continuation are actually demonstrated.
