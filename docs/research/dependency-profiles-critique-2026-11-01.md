# Dependency profiles: adversarial critique and decision log

**Status:** design self-review, 2026-11-01; not an independent multi-model review, approval, implementation or published contract. This log is subordinate to the [implementation specification](dependency-profiles-implementation-spec-2026-11-01.md). The owner must independently review the final decision and later code.

## Method and limits

Six separate adversarial viewpoints were applied to the public-main manifests, accepted Stack/Foundation ownership, local working-tree inventory summary, pnpm catalog behavior and current update tooling. These are reasoned passes by the assistant, **not executed external subagents**. GitHub PR #458's actual ReviewRouter response was **incomplete**: 0/2 files covered, provider evidence missing. It cannot count as an independent approval. No live updater E2E, npm publication, sandbox pg version update or consumer implementation has been performed.

Primary verification sources:
- Stack owner: https://github.com/agent-teams-ai/engineering-foundation/blob/main/docs/decisions/0064-independent-stack-toolchain-package-boundary.md
- Existing dependency rules: https://github.com/agent-teams-ai/engineering-foundation/blob/main/docs/reference/workspace-dependency-declarations.md
- Gateway server: https://github.com/agent-teams-ai/account-gateway/blob/main/services/account-gateway/package.json
- Payments adapter: https://github.com/agent-teams-ai/payments-sdk/blob/main/packages/payments-postgres/package.json
- Payments manager catalog: https://github.com/agent-teams-ai/payments-sdk/blob/main/pnpm-workspace.yaml
- Shared Renovate preset: https://github.com/agent-teams-ai/.github/blob/main/renovate-config.json
- Renovate pnpm catalog and native lock: https://docs.renovatebot.com/modules/manager/npm/
- Renovate post-update task risks: https://docs.renovatebot.com/security-and-permissions/
- pnpm catalog/pack behavior: https://pnpm.io/catalogs

## Findings by priority

| Severity | Critic lens | Initial assumption / concrete failure | Resolution in revised specification | Remaining evidence |
| --- | --- | --- | --- | --- |
| P0 | Architecture, policy ownership | Stack releases themselves own pg/Zod app choices; every version bump implies a compiler/lint package release and mixes app selection into a neutral tool | Stack owns reusable validation/projection mechanism; separately governed immutable catalog data owns choices; distinguish release identities | Decide between retained Git snapshot or independent inert artifact, qualify publication/readback |
| P0 | Actual fleet UX | A central catalog/locked revision exists, but no route to complete native PRs in many repositories was proven | Explicit delivery acceptance: one catalog change -> complete finite PR per opted-in repo, or transparently label manual stage | Real two-repo updater spike and PR contents |
| P0 | Peer contract | Payments uses one pg default catalog for both optional peer and dev; upgrading an apparently dev-only version changes packed peer requirement | Exclude peer mutation from first writer; block coupled updates and require Payments-owned separate qualification | Inspect actual packed peer and test allowed/disallowed consumers |
| P0 | Security of proposal bot | Assuming Renovate postUpgradeTasks will run a custom projection silently is both false by default and a privileged execution risk | Reuse native manager handling first; no privileged script/expanded app token without separate approval | Verify updater installation, permissions, failure behavior and exact commands |
| P1 | Wrong adoption assumption | Shared Renovate preset exists but does not establish it is enabled in Gateway/Payments; actual sampled PRs were Dependabot | Distinguish existing configuration from activation; keep current bot paths until separately qualified | Verify real installation or select manual proposal route |
| P1 | Status correctness | Current adopted catalog revision and newest available are conflated: an intentionally paused repo could fail normal CI | Drift is only against the repo's adopted revision; newer revision is informational proposal; expired exact exceptions explicit | Negative fixture for older-but-consistent repo |
| P1 | Clean Architecture | Central generic catalog includes application/library allowed dependency kinds, duplicating consumer/F3 governance | Catalog only knows package selections; consumer owns literal target, kind and peer contract | Cross-verify with Foundation workspace rules |
| P1 | Lock ownership | Version equality was close to being treated as dependency-graph proof | pnpm owns lock, SRI and peers; frozen installs/packed and actual product tests remain authoritative | Real pnpm version-specific E2E |
| P1 | Manager matrix | The sample was described as pnpm-only, but Get Modular public root uses Bun | Qualify pnpm only for initial writer; do not claim fleet support | Separate Bun-native consumer inventory/adapter later |
| P1 | Stale preimages | Applying a selected-field patch from an old PR head could erase unrelated concurrent edits | Whole-file hashes + source head SHA for candidate write, and bounded diff; no blind retry | Concurrent edit and remote change rejection fixture |
| P1 | Machine authority | A digest of catalog bytes proves integrity only if source, release and provenance are bound; moving latest can fetch wrong data | Immutable explicit catalog revision, digest, trusted retained/installed artifact and offline check | Demonstrate artifact/commit trust chain, no fallback to moving refs |
| P1 | YAML mutation | Rewriting default/named catalogs without preserving comments/quotes may churn unrelated policy | Prefer native updater; only make a minimal structure-preserving adapter for missing capability, with duplicate/alias rejection | No-write diff fixture on real Gateway/Payments workspace layouts |
| P1 | Fleet collision | Central updater and Dependabot may both propose the same selected field; PR storms and stale bases | One owner of selected-field proposals per enrolled repo; existing PR limits remain; stale proposal is superseded/rebased not force-applied | Two simultaneously offered revisions and two bot collision tests |
| P2 | Complexity | The initial 350-600 LOC estimate implied a full updater, schema and safe cross-repo rollout | Estimate restricted to pure check slice; deliver a technical spike before sizing the writer | Actual LOC/complexity measured after spike |
| P2 | Onboarding | Requiring users to edit several configs, declare role matrices, and copy versions defeats central usability | One explicit selection file or equivalent existing config, minimal family/target input, direct library imports | Observe onboarding on an unprepared disposable consumer |
| P2 | Review evidence | Auto-review was reported as incomplete; repeating reviewer-role narratives might be mislabeled as multi-agent review | This record is explicitly self-review; independent review remains pending | Exact-head independent review by an actually executed reviewer |

## Reviewer pass A: architecture and DDD

**Attack:** An all-purpose cross-repo framework makes every repo import a Stack runtime facade or wires product rules into a generic schema. A new Foundation catalog then competes with Stack. This is both DRY and authority failure.

**Answer:** the feature is a version-selection projection/check, not a dependency-injection platform. Keep packages directly imported; a library owns its peer constraint; a consumer owns kind/path and qualified test gates; generic Stack mechanism knows only inert data and package-manager adapters. DDD is relevant to existing product contexts, not an excuse to invent aggregates in a catalog parser. The portable tool is never a production dependency.

**Residual risk:** adding a separately versioned data artifact would amend accepted release graphs only through the owning future ADR; avoid speculatively creating the package.

## Reviewer pass B: version authority, upgrades and semantics

**Attack:** One universal exact version for all projects breaks the legitimate difference between package installation and a library's broad compatible peer range. Forcing newest version across every consumer will either hold everyone back or mask drift with unsafe waivers.

**Answer:** central catalog expresses exact desired **install** selections for opt-in families. Peer semantics remain in consumer, and intentional older adopted catalog revisions are legal and visible. A single accepted recommended version can coexist with consumer-specific deferred adoption; additional catalog tracks require a real qualified incompatibility, not a global exception bucket.

**Residual risk:** catalog immutable release/commit type has not been chosen; compare artifact packaging and trust, not just developer convenience.

## Reviewer pass C: pnpm and real packaging

**Attack:** A YAML edit changes the pnpm effective version but neglects the real shipped library's peer range; or a script reconstructs a lockfile while ignoring manager engines/patches/lifecycle. A catalog: token is not what pnpm publishes.

**Answer:** pnpm owns lock generation; inspect exact packed output; preserve @types/pg mismatch and peerDependenciesMeta; refuse unsafe coupling. Positive and negative consumer installs use actual packages, not only string inspection. Use exact pinned manager and frozen CI.

**Residual risk:** actual manager-native transformations with the target pnpm versions need a disposable spike.

## Reviewer pass D: supply chain and PR security

**Attack:** A shared updater running arbitrary postUpgradeTasks has broad GitHub token access, executes altered dependencies, and writes changes to untrusted repositories. Exact catalog strings by themselves do not prove provenance.

**Answer:** offline read-only checks, immutable selected artifacts, bounded inputs/commands, no broad workflow scopes or lifecycle permission changes, and per-repo owner review. Reuse Renovate's native manager adapter if it can do a complete PR without elevated shell hooks. Protect staged candidate updates with exact head/preimage/diff checks. Opaque unverified artifact is blocker.

**Residual risk:** actual app permissions/runner isolation and an acceptable alternative on hosted updater plans remain open.

## Reviewer pass E: end-user ergonomics and scale

**Attack:** The original design reduces copy/paste but central maintainers still manually update six repos, or receive incomplete catalog-only PRs which immediately fail CI. It also reports every lagging repo as broken, making a shared catalog annoying.

**Answer:** explicit complete-PR acceptance test, small opt-in family and clear Current/Update available/Proposed/Blocked/Deferred/Drift/Unknown states. Retain reasonable existing PR concurrency and avoid multiple bots managing selected fields. Do not require universal full-stack installation. A project without the tool and validated manager is not enrolled.

**Residual risk:** actual automated proposal delivery has not been demonstrated, so do not promise one-click fleet convergence or hidden auto-merge.

## Reviewer pass F: recovery, partial adoption and no overengineering

**Attack:** Multi-repo adoption is presented as a transaction; one blocked SDK repo forces a fleet rollback; adding a coordinator, queue, dashboard and workflow engine causes more risk than the dependency updates.

**Answer:** one independent reviewed PR per repo, no atomic fleet cutover. Deferred previous catalog revisions remain installable; a rollback is a new approved revision/proposal. Disposable candidate stage and exact preimages prevent collateral edits. A dashboard, hosted state database, reconciliation scheduler, generic SAT engine and npm/Yarn/Bun adapters are all excluded from the first pilot.

**Residual risk:** if existing Renovate/Dependabot cannot safely generate complete PRs, the owner must choose a plainly labeled manual stage or separately authorize a tiny proposal adapter; do not implement a fleet daemon by inertia.

## Hard go/no-go gates before code

1. Owner chooses exact central data owner and independently versioned distribution (retained immutable Git bytes or a data-only artifact). No new package name has been accepted.
2. A disposable two-consumer pilot proves how a single approved revision becomes **two complete package-manager-native PR artifacts** without silently enabling arbitrary scripts. Check whether Renovate is actually installed; the existence of a shared preset is not enough.
3. Payments optional peer published range is inspected and the coupled pg change refuses if not separately qualified. Keep library owner freedom to declare a compatible range.
4. Per-repo CI gates distinguish selected-revision drift from informational newer revisions, and permit an old but internally consistent exact pin.
5. Independent technical reviewer examines the exact final design; the incomplete ReviewRouter result is explicitly not review approval.

**Verdict:** architectural direction retained but material assumptions rejected. Design is ready for owning decisions and a bounded disposable updater spike, **not** approved for code, public names, release, or automatic fleet rollouts.
