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

## Long-horizon hostile scenarios: 6 months, 2 years, 5 years

This is a **failure-mode exercise**, not executed E2E evidence. Each counterexample names a falsifiable outcome. The right response for most is an explicit stop, a standard CI check or an operator action **rather than another service or schema**. "P0" means a must-resolve before first production writing; "P1" means prove the applicable real consumer and state transition before broad rollout; "P2" is a documented future trigger, not a requirement to build today.

| Priority | Horizon / adversarial event | Expected safe behavior | Minimum proof or ownership |
| --- | --- | --- | --- |
| P0 | Today: an approved Zod-only catalog revision lands while the consumer opted only into YAML | No false drift, no catalog-pointer-only PR, no forced version refresh | Effective selected-field diff, not global release counter |
| P0 | Today: a new selected pg dev pin also changes Payments optional peer via the **same pnpm catalog** | Refuse writer; keep shipped peer unchanged until separate library-owner qualification | Actual packed positive/negative consumers; peer metadata comparison |
| P0 | Today: trusted shared Renovate file exists but the repo has only Dependabot **security** updating | Do not claim automatic central version fan-out | Verify installed updater and configuration, not bot username alone |
| P0 | Today: central data artifact version changes but local pnpm values/lock remain stale | No half-complete PR or "Current" status | Compare actual selected fields, exact manager-generated lock and PR diff |
| P0 | Today: a maintainer-controlled post-update script executes in a privileged updater bot | Reject unreviewed script and broad credentials; do not use it as shortcut | Update-runner trust boundary and least-privilege permission review |
| P0 | Today: new central desired version is **lower** than a consumer's installed version | Mark manual, approved recovery; never assume routine updater can downgrade | Actual negative updater fixture, no fabricated rollback PR |
| P0 | Today: a consumer's main advances while a prepared update is being applied | Abort stale plan, reobserve HEAD/whole-file preimages, rerun real manager | Controlled concurrent-edit rejection before write and before PR |
| P0 | Today: strict pnpm lock changes transitives beyond the named direct dependency | Inspect broader lock delta; no homemade graph-resolver rejection; enforce ordinary frozen/install E2E | Lock regenerated by exact manager with real SRI and critical tests |
| P0 | Today: security advisory affects an indirect package with unchanged selected direct pin | Preserve independent Dependabot security fix; do not suppress lock-only proposal | Verify advisory fix path and retained selected direct authority |
| P1 | 6 months: central released version is malicious or provenance/trust root compromised | Pause new proposals, identify impacted exact catalog revisions and PR SHAs; no remote forced revert | Owner incident runbook, immutable release/digest/source evidence |
| P1 | 6 months: upstream package yanked or registry/network unavailable | Existing selected state can be checked offline; new proposals show unavailable, not guessed latest | Frozen old install where artifact is obtainable, explicit availability-blocker otherwise |
| P1 | 6 months: two central updates arrive faster than slow repository reviews | At most one normal candidate per target group, supersede only unmerged with fresh head and CI; owner can defer | Sequence R1→R2→R3 with pending PR and stale check |
| P1 | 6 months: 30 repos opt into same family; CI resource pressure and review spam | Scoped proposal batches, existing per-repo PR limits, no irrelevant PRs; hold other cohorts without blocking them | Measured PR/CI volume on disposable fleet, no scheduler |
| P1 | 1 year: project is Bun-native while checker only knows pnpm | Explicit unsupported/no-write, no silent pnpm adaptation | Get Modular boundary input; cross-manager support demands own pilot |
| P1 | 1 year: pnpm 12 docs include a setting absent from a consumer's pinned pnpm 11 | Use exact manager version/capability; reject unknown syntax or config ownership | Pinned pnpm 11 disposable fixture (do not infer v11 from current docs) |
| P1 | 1 year: a library has optional peer that is absent for some consumers | Do not label absence or incompatible present peer as equivalent; preserve optional metadata | Packed clean no-pg consumer, compatible-pg consumer and incompatible-present peer evidence |
| P1 | 1 year: Node 24 and Node 26 cohorts cannot use the same vendor release | One separately justified compatibility track only for measured need; no global forced downgrade | Real compilation and runtime gating for each selected track |
| P1 | 1 year: common lockfile transitive changes introduce a vulnerable dependency | Selected-version equality is not security green; keep advisory scanning and ordinary locked graph checks | Security/lock CI separate from read-only version report |
| P1 | 2 years: one repository has a different explicit license/engine/ABI admission rule | Per-repo qualification can block one candidate while others proceed | Consumer-specific compile/native/security gates; no catalog policy override |
| P1 | 2 years: GitHub shared-preset cache or mutable ref becomes stale/changes silently | Remote updater proves effective source identity; offline builds use committed manifests/locks and retained approved revision | Exact provenance readback; no network dependency for normal CI |
| P1 | 2 years: two bots propose different values for the same field; security exception gets suppressed | One normal proposal owner, security fast-path separate and visible; no bot tug-of-war | Simulated duplicate proposals, advisory exception with expiry |
| P2 | 2 years: 200 distinct packages in one catalog, one update creates dozens of empty PRs | Filter to effective enrolled selected fields, avoid one global revision bump per unchanged consumer | Only add family comparison data if a real false-positive is observed |
| P2 | 2 years: repos split across GitHub organizations or change their name | Portable checker does not depend on organization; proposal permissions explicitly re-enrolled | New hosting adapter only after real need; no ambient crawl |
| P2 | 5 years: packages move to npm alias, private registry or language-specific manager | Unsupported v1 selection remains explicit; do not add implicit compatibility | New separately scoped real consumer/adaptor admission |
| P2 | 5 years: long-lived supported library peers intentionally span major versions | Keep published peer compatibility owned by library, never universal exact pin as peer | Positive and negative independent installed consumers for actual ranges |
| P2 | 5 years: owners want automated fleet status dashboards and emergency pause buttons | Derive status from existing PR/CI and retained inputs first; avoid another database/scheduler | Measure operational pain and authorize a separate UI only then |

### Minimum adversarial scenario narratives

**A. Review stops at the wrong SHA.** A bot opens update R2 on main A; PR checks pass and reviewer approves; main advances to B, another bot rewrites the lock, and the update bot rebases to head C. Neither approvals nor CI from old head/A qualifies C/B. Independent final-head review/CI requirements remain consumer-owned and must be reevaluated. A status called "PR created" is not "safe to merge".

**B. No-op version releases are noisy.** Central revision R3 changes Ajv. A project enrolled only in YAML at an older immutable R1 gets an R3 artifact revision proposal with no YAML selection change. This violates user intent. Reject or suppress such a proposal using the selected effective package comparison, not global revision freshness. Do not create a second hand-maintained release graph to accomplish this.

**C. Default pnpm catalog is reused by two semantic roles.** Payments' optional pg peer and dev pin both use catalog:. An updater edits one YAML scalar and native pnpm completes without error, yet the published adapter now advertises an unexpectedly different peer requirement. A green frozen lock is insufficient: block and require real packaged consumer tests and a separate library-owner intent to change that contract.

**D. Central version source itself becomes compromised.** An attacker with write access changes the recommended version to a malicious but *syntactically valid* npm release and signs/commits it. SHA-256 only proves the exact malicious bytes match, not safety. The approval and production promotion of the central source must be protected by repository review/provenance plus staged consumer qualification. The quick response is disable new proposals and trace exact affected revisions, not trust immutable hashes to prove behavioral safety or mass-revert unrelated projects.

**E. Vulnerability under a frozen direct catalog pin.** A transitive fast-uri advisory arrives while central desired direct pin is unchanged. Dependabot security PR can legitimately update the lock graph. A strict checker must not reject such a patch for leaving an old approved direct pin unchanged, but a frozen install/security gate still has to pass. If an urgent *direct* bump violates central selection, use an exact reviewed and expiring exception, not generic overrides or ignored alerts.

**F. New manager changes syntax.** The upstream pnpm site now documents features added in pnpm 12; existing target repos pin different pnpm 11 releases, and Get Modular names Bun at root. A generated projection using a new unsupported pnpm 12 feature or accidentally running Bun in a pnpm-only pilot is invalid. The actual selected manager and its native test run determine qualification, not a generic manager adapter.

**G. Client status becomes misleading.** A repo remains on approved revision R1 while the central recommendation is R3. Its normal CI checks equality to R1 and succeeds; the updater reports R3 as an opportunity; policy can ask for a dated deferral. If R1 is known vulnerable, the advisory/exception path independently records urgency. Neither silently relabels the repo "up-to-date with R3" nor breaks all builds because a remote recommendation changed.

**H. Vendor adoption never ends.** A new repository such as a proposed Dogman consumer may have its own runtime, engine and product constraints. No profile is inferred from a label or repo name; a minimal enrollment requires a real maintained manifest, manager, package role, qualified direct import and owner agreement. A catalog that forces a universal full stack defeats adoption and creates an unbounded support obligation.

### Operational playbook — no new service

1. **Routine:** review an exact proposed catalog/preset version choice; use the already-qualified updater to create finite per-repo PRs, each owner checks its native build/E2E. No autonomous merge or cross-repo transaction.
2. **Blocked single consumer:** keep its previous adopted revision, report reason, owner and next review trigger; proceed with unrelated consumers; no fake universal rollback.
3. **Security hotfix:** permit advisory-driven transitive lock update independently; direct selected changes need exact approved temporary exception or catalog update. Never bypass real tests or erase vulnerability signal.
4. **Suspected malicious central revision:** pause new proposals, audit source/provenance and affected repos/PRs, revoke appropriate compromised permission through the real owner procedure, then issue corrected immutable revision and separate recovery PRs. No automatic repo mutation.
5. **Updater/network outage:** existing frozen installs and offline consistency checks continue where dependency artifacts remain obtainable. New update proposals show unavailability; do not adopt unverified latest or claim a stale cache was fresh.
6. **Upgrade stuck for months:** report a dated deferral and compatibility reason rather than building a fleet dashboard or failing CI forever. Escalate only when security/critical upstream support actually requires it.

### Decision minimality and explicit exit tests

The portable Stack feature, independent version artifact and GitHub proposal adapter are **options**, not a required three-service system. Establish one gap at a time. First test the zero-new-feature path: approved shared Renovate exact-version policy (where truly enabled), native pnpm catalogs, current Dependabot security updates and existing frozen install/CI. If that produces two complete safe PRs from one central change, the system may need **no new code** and no second catalog. If not, write down exactly which input/projection is missing before authorizing a small library.

**Do not build in v1:** release dashboard, fleet deployment coordinator, transitive SAT solver, graph database, compatibility-auto-inference matrix, version telemetry service, framework-specific profiles without real consumers, one PR touching multiple repositories, automatic merge, universal manager adapter or custom registry. Each would require a measured independent problem and owner decision later.

## Hard go/no-go gates before code

1. Owner chooses exact central data owner and independently versioned distribution (retained immutable Git bytes or a data-only artifact). No new package name has been accepted.
2. A disposable two-consumer pilot proves how a single approved revision becomes **two complete package-manager-native PR artifacts** without silently enabling arbitrary scripts. Check whether Renovate is actually installed; the existence of a shared preset is not enough.
3. Payments optional peer published range is inspected and the coupled pg change refuses if not separately qualified. Keep library owner freedom to declare a compatible range.
4. Per-repo CI gates distinguish selected-revision drift from informational newer revisions, and permit an old but internally consistent exact pin.
5. Independent technical reviewer examines the exact final design; the incomplete ReviewRouter result is explicitly not review approval.

**Verdict:** architectural direction retained but material assumptions rejected. Design is ready for owning decisions and a bounded disposable updater spike, **not** approved for code, public names, release, or automatic fleet rollouts.
