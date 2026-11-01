# Dependency profiles: implementation specification and bounded pilot

**Status:** PROPOSED DESIGN ONLY, revised 2026-11-01 — not accepted, implemented, published or qualified. [Deep adversarial critique and decision log](dependency-profiles-critique-2026-11-01.md). PR #458 ReviewRouter reported incomplete coverage (0/2 files); this is not independent review or approval.
**Snapshot date:** 2026-11-01.
**Owner candidate:** the existing independent Stack Toolchain package in Engineering Foundation.
**Change boundary:** specification only. This document authorizes no new package name, public command, profile capability, release, automatic dependency update, or migration of consumer repositories. Token is excluded. Existing Toolchain migration and delivery/E2E PRs are independent and must not be edited by this work.

## 1. Problem, concrete user journey and success criteria

The problem is version-selection duplication across independent repositories. A native workspace catalog solves repetition *within* one pnpm workspace; it does not distribute one reviewed version choice across Gateway, Payments and other independently released projects. Consumers must keep ordinary vendor imports and their own runtime/peer/CI guarantees, with no umbrella runtime dependency.

**Desired maintainer experience (design target, NOT implemented):** explicitly enroll a literal project/manifest and one small dependency family once; review one central choice of an exact vendor version; receive a separate complete proposal PR per eligible enrolled repository; let each repo independently qualify and merge that proposed change. One central choice is not a global force-upgrade or multi-repo transaction.

The central change must update the actual selected package.json or manager-native default/named catalog **and manager-owned lockfile**, not only an abstract catalog pointer. Successful end-to-end delivery requires two complete consumer PR artifacts from one central approved revision, with unchanged out-of-scope fields, exact source identity, normal frozen-install and critical consumer gates. A single generated JSON report or unverified Renovate config is insufficient.

**Small user-facing status vocabulary:** A selection check that reports Current is **not** a statement that the lockfile, security posture or application runtime passed qualification.

| Status | Meaning | Action |
| --- | --- | --- |
| Current | Selected manifest/native catalog match the **consumer's adopted** immutable revision | Lock freshness and runtime compatibility are separately proven by frozen install and actual consumer gates |
| New revision available | A newer centrally approved catalog revision exists, but the currently adopted version still matches itself | Offer a PR; do not fail normal offline CI |
| Proposed | A bounded consumer PR is available and awaits product-owner checks/review | Review and qualify |
| Blocked | Manager, peer contract, security, provenance or consumer CI rejected the candidate | State the exact reason; never repair/fallback silently |
| Deferred | Older revision intentionally retained, with owner and review trigger | Keep normal builds working; surface upgrade debt |
| Drift | Selected field differs from the consumer's **adopted** revision without an exact exception | Read-only consistency check fails |
| Unknown | Missing catalog/target/manager or incomplete evidence | Do not report success |

A future repo, including an example such as Dogman, becomes a consumer only after identifying its real package paths, supported manager and explicit owner enrollment; name resemblance or shared libraries never activate a profile. No auto-discovery or forced full-stack choice.

## 2. Evidence, scope and public-main reconciliation

The supplied local working-tree inventory is identified as selected-consumer-dependencies.json, SHA-256 e59d93afe7cdee711b63d241ac5a1d1826c5c1f5973fe73730d4b0e463867049. Its reported 24 manifests, six named repositories, roles and dependency counts are useful design input, **not a reproducible public-main claim**. The inventory bytes are not part of this change and were not independently rehashed. A working-tree observation cannot establish fresh-main, transitive resolution or runtime/peer compatibility.

Directly checked public GitHub defaults on 2026-11-01:

| Repository and main SHA | Verified selected fact | Consequence |
| --- | --- | --- |
| Engineering Foundation, a12a093e680cbfa3b5522f1b6f8b7a48bace45b6 | packages/stack-toolchain/package.json is version 0.1.1, its public source is within this monorepo, and the package currently exposes tool/preset/doctor surfaces; source ownership follows ADR-0064 | Extend the existing owner; do not create a competing registry/service or claim this extension already ships |
| Account Gateway, 60bc0aab73c09141674757bd7766ec7e00e57bff | Root directly pins Stack 0.1.1 and Foundation 3.0.0; services/account-gateway/package.json has pg 8.23.1 under dependencies and @types/pg 8.23.1 under devDependencies; its pnpm-workspace.yaml currently has no dependency catalog | Application fixture must cover an exact direct runtime pin; do not silently convert the workspace to catalog protocol |
| Payments SDK, 7052c0e25ef4e145d555192806ba9c695d8a5ace | Root pins Stack 0.1.1 and Foundation 3.0.0. packages/payments-postgres/package.json declares pg under optional peer and development, both catalog:. pnpm-workspace.yaml selects pg 8.23.1, @types/pg 8.20.0, strict peer/catalog modes and an existing Drizzle patch | Library fixture must preserve native catalog/peer semantics and unrelated type/driver/patch decisions |
| Agent Teams Orchestrator, current public root checked 2026-11-01 | Root still pins Foundation 1.7.2 and does not declare Stack 0.1.1 | Not qualified for this feature by the supplied six-root assertion; independently migrate only through its own owner gates |
| Agent Runtime, current public root checked 2026-11-01 | Root still pins Foundation 1.7.2 and does not declare Stack 0.1.1 | Same exclusion; its labeled workspace experiment is not a second production consumer |
| Get Modular, current public root checked 2026-11-01 | Uses Foundation 3.0.0 and Stack 0.1.1, but root packageManager is bun@1.4.3, with a separate pnpm tool pin | Do not imply the entire fleet is pnpm-only or claim Bun support based on a pnpm-only pilot |

These rows are **not a replacement for the six-repository local sample**: its exact membership and byte-level SHA mapping cannot be reconstructed from the summary alone. Before implementation, retain a separate current-main manifest/manager ledger with exact root commit and input blob SHA for each **explicitly selected** consumer; do not broaden the cohort automatically.

At the review snapshot, Engineering Foundation PR #457 is open and modifies Stack/F3 formatting surfaces. Gateway's Toolchain adoption PR #84 and Payments' adoption PR #17 are merged, but other repository/product gates can still be active (in particular Payments PR #15). Develop this document off main in its own branch. When implementation is authorized, rebase that later work on the then-current integrated owner contracts; never cherry-pick into, amend, or merge unrelated Toolchain PRs as part of this design.

Source links: [Stack package](https://github.com/agent-teams-ai/engineering-foundation/blob/main/packages/stack-toolchain/package.json), [ADR-0064](https://github.com/agent-teams-ai/engineering-foundation/blob/main/docs/decisions/0064-independent-stack-toolchain-package-boundary.md), [Gateway server](https://github.com/agent-teams-ai/account-gateway/blob/main/services/account-gateway/package.json), [Gateway workspace](https://github.com/agent-teams-ai/account-gateway/blob/main/pnpm-workspace.yaml), [Payments adapter](https://github.com/agent-teams-ai/payments-sdk/blob/main/packages/payments-postgres/package.json), [Payments workspace](https://github.com/agent-teams-ai/payments-sdk/blob/main/pnpm-workspace.yaml), [existing Foundation workspace rules](https://github.com/agent-teams-ai/engineering-foundation/blob/main/docs/reference/workspace-dependency-declarations.md).

## 3. Explicit invariants and excluded scope

1. **One desired-version authority; different technical authorities.** The catalog's owner selects exact recommended *install* versions. The consumer owns its adopted catalog revision, package kinds, real peer compatibility and exceptions. Its package.json or native catalog entries are tool-required projections, and pnpm owns the resolved graph/SRI in the lock.
2. **Separate data and mechanism lifecycles.** The existing neutral Stack Toolchain owns the portable comparison/projection *mechanism*, not organization-specific pg/Zod/YAML version policy. A catalog change should not require shipping an unrelated TypeScript/linters release by default. No second Foundation catalog or duplicated consumer-local desired-version authority.
3. **Opt-in literal targets.** One small named family and exact maintained package.json paths; reject ambient discovery, arbitrary globs, cross-repo scans and universal full-stack profiles. The consumer declares its selected dependency section(s) and literal/catalog provenance; no policy inferred from path.
4. **Direct vendor ownership.** Apps keep direct runtime dependencies. A library controls its own peerDependencies, optional peer metadata and qualification dev pins. No umbrella dependency, runtime re-export, forced shared adapter, hidden React transitive or automated movement between dependency kinds.
5. **Existing boundaries.** Foundation's workspace-declaration policy is independent and may consume a read-only drift result without changing its contract. node-or-bun remains the process execution mechanism; no new executor, job scheduler, queue or actor. Product financial/security policy and strict tests remain local.
6. **Read-only truth, staged changes.** No network, install, file modifications or code execution during consistency checks. Candidate proposals must use approved data, exact preimages, bounded diffs, the consumer-pinned manager and repository-owned PR gates; no silent repair, auto-merge or promise of atomic multi-repo cutover.
7. **Preserve unselected policy.** Never rewrite overrides, patchedDependencies, local parser/compiler islands, engines, packageManager, scripts, lifecycle permissions, peer ranges, @types differences or unrelated pnpm catalog entries. Node test runners remain; fast-check is only a supplementary test library.

Out of first implementation: token, React/Vite/Vitest/Playwright or frontend claims without actual consumers, Bun/npm/Yarn adapters, full repo migration, peer SAT solving, automatic stack inference, transitive manager, hosted dependency registry, fleet state database, dashboard, background scheduler, generic dependency/architecture framework, new public CLI without an owner decision.

## 4. Clean Architecture, ownership and delivery boundaries

Revision-1's assumption that Stack owns *the chosen catalog values* is rejected as a default. Stack must remain organization-neutral and reusable while organization/project maintainers select *their* versions. Tool code and catalog selections need separate upgrade lifecycles.

| Boundary | Owns | Does NOT own |
| --- | --- | --- |
| Existing Stack Toolchain | Stable portable strict input model, schema/loader, deterministic comparison and finite projection planning; narrow native adapters only when actually needed | Chosen organization versions, app/library policy, fleet orchestrator, compatibility verdict, runtime vendor imports |
| One independent inert catalog data authority | Named, opt-in families of exact recommended vendor installation selections; immutable revision/digest/provenance | Product topology, dependency-kind policy, peer compatibility ranges, package manager resolution |
| Consumer and package manager | Exact enrolled package paths, dependency sections, adopted catalog version, local peer/exception policy, native pnpm input files, lockfile and critical CI | A second hand-maintained desired-version catalog |
| Foundation, if adopted | Existing local declaration/architecture policy and optional read-only drift gate | Duplicated catalog, new runtime dependency, rewriting consumer versions |
| Existing Renovate/Dependabot or approved future proposal adapter | Native manager-aware **proposals** for opted-in consumers | Central desired-version authority, unreviewed merges or arbitrary privileged scripts |

**Distribution is an owner decision, not an accepted package name:**

| Option | Pros | Main cost / decision |
| --- | --- | --- |
| Embedded catalog in each Stack release | Simple tiny disposable spike | Reject as long-term default: pg changes force unrelated toolchain releases and mix data policy with mechanisms |
| Immutable central Git JSON + consumer retained snapshot | No extra npm package; exact commit and bytes possible | Needs verified revision adoption, offline snapshot freshness and safe complete-PR route |
| Independently released data-only artifact | Independent revisions; manager can pin exact archive/cache/SRI; release candidates discoverable | Requires one bounded new distribution identity and actual release proof; artifact bump alone does not project native versions |

Prefer the smallest **separate** data distribution that a two-repo updater spike can really deliver; an independent inert data artifact is the leading candidate if native updater support is demonstrated, otherwise an existing immutable Git + cached snapshot can be evaluated. Neither public name nor publication is decided here; only one data authority may exist after decision. Merely introducing a new package without a complete propagation path would be wasted complexity.

### 4.1 The strongest skeptical alternative: build nothing new

**Baseline A — zero new packages, zero Stack API:** an opt-in [shared Renovate preset](https://docs.renovatebot.com/config-presets/) may be enough to express central version policy, select package names/kinds and let Renovate create native package/lock PRs. Its [allowedVersions](https://docs.renovatebot.com/configuration-options/#allowedversions) is documented as a *version constraint*, however, not an exact-version synchronization or downgrade API. Changing the central preset does not by itself prove that every opted-in target gets the exact requested version. A preset pointing at a moving Git ref is not immutable offline CI authority. Test this rather than assuming either success or failure.

**Baseline B — retain Dependabot security, qualify routine updates separately:** GitHub supports [pnpm workspace catalogs](https://github.blog/changelog/2025-02-04-dependabot-now-supports-pnpm-workspace-catalogs-ga/), but its [security updates can run without dependabot.yml](https://docs.github.com/en/code-security/concepts/supply-chain-security/about-the-dependabot-yml-file), while routine version updates require an explicit configuration. Gateway/Payments sampled fast-uri PRs were security updates. Neither their existing Dependabot activity nor the shared Renovate file proves routine cross-repo exact-version propagation.

**Baseline C — only after measuring a gap:** an independently versioned inert catalog and minimal portable checker may be justified. A bump to a catalog artifact alone, leaving selected manifests/native catalog values stale, is an *incomplete* proposal and fails the central-update UX. A new fleet proposal coordinator is not the automatic fallback.

**Hard decision rule:** if Baseline A or B can safely create complete reviewable PRs and existing frozen manager/CI gates already establish the required behavior, **do not implement a new Stack dependency-profile feature**. Document the selected existing native workflow and add only necessary opt-in configuration. A separate offline checker is justified only for a demonstrated drift that native manager/manifest and existing Foundation checks cannot detect. This makes avoiding overengineering a measurable design constraint.

One cohesive Stack feature suffices if missing capabilities are proven. Pure selection policies receive normalized immutable observations; application comparison/plan operations depend on ports; filesystem/pnpm adapters own external shapes and the existing NOB subprocess boundary; GitHub PR delivery remains an *outer workflow concern*, never a Stack kernel service. No DI container, DDD aggregates for JSON, actor system, plugin host, new workflow engine or package-per-class structure.

## 5. Candidate data contracts — conceptual, NOT public APIs

Only small, evidenced families of exact **install selections** live in the central catalog. No global application/library dependency-kind whitelist: package roles and peer policy belong to the consumer. A second named compatibility track needs a real incompatible consumer and proof; no combinatorial full-stack preset explosion.

Conceptual strict JSON example:

~~~json
{
  "schemaVersion": 1,
  "families": {
    "postgres-client": {
      "packages": { "pg": "8.23.1" }
    }
  }
}
~~~

This is an illustration, not a promised schema, path, published package or available command. The actual admission schema must reject unknown/duplicate JSON fields, mixed version syntax, conflicting selections, invalid npm names and unreviewed aliases, ranges, tags or URLs. JSON.parse by itself silently accepts duplicate keys; use a strict existing parser or explicit duplicate-key validation. Source bytes and limits must be bounded, with one normalized deterministic rendering where canonicalization is required.

**Identity:** separate schema version, immutable *catalog* data revision, SHA-256 of the **exact catalog JSON bytes** outside its hashed document, separately verified distribution archive integrity/provenance where an archive exists, exact vendor version, installed Stack checker version, consumer's adopted revision and newer offered revision. A moving branch/tag and a "latest" lookup are never a CI authority. Changing the catalog makes a new immutable revision, *not necessarily a new Stack Toolchain release*. Verify release provenance/physical artifact against the selected reference before reporting that data is available.

**Avoid irrelevant-revision churn:** distinguish the entire catalog's immutable revision from a consumer's *effective selection*: the subset of enrolled package names, exact chosen values and any explicitly qualified compatibility track. If Zod changes centrally but one consumer opted only into YAML, a new global revision alone must **not** cause an empty YAML PR or failing CI. It may retain the earlier immutable catalog reference. Derive selected-field differences instead of inventing a second hand-maintained per-family release table.

**Compatibility tracks, not a matrix explosion:** a central exact pin is a reviewed recommendation, not a guarantee that every supported Node version, library peer or platform supports it. Only a real evidenced incompatibility may justify one additional opt-in named track for that family. A target selects exactly one track, and changing tracks is a consumer-owner decision. Do not infer combinations such as Node24/Node26, app/library role or React version by default; no automatic fallback to a different track.

**Consumer selection:** explicit inert input maps exact repo-relative package.json paths to named catalog families/packages, actual dependency kinds and the literal/default/named-catalog read surface. It pins an exact catalog revision plus content digest and may select only part of the catalog. It cannot execute code, load JavaScript config, follow symlink escapes, traverse parents, select duplicate path identities or expand globs. The consumer, not catalog, decides whether a field is dependencies, devDependencies, peerDependencies or optionalDependencies.

An illustrative selection record (field names and placeholder revision identity are **not** agreed public schema):

~~~json
{
  "schemaVersion": 1,
  "catalog": {
    "revision": "<immutable-approved-revision>",
    "sha256": "<verified-catalog-file-sha256>"
  },
  "targets": [
    {
      "manifest": "services/account-gateway/package.json",
      "family": "postgres-client",
      "package": "pg",
      "kind": "dependencies",
      "source": "literal"
    }
  ]
}
~~~

A Payments read-only selection would use its real adapter package path, actual development/peer observations and default pnpm catalog provenance rather than pretending its runtime peer is a direct application pin. This is an **input illustration** only; exact names/path and CLI remain subject to the owning design decision.

**Peer contract separation (critical):** Gateway uses a direct runtime pg 8.23.1 pin. Payments currently uses one default pnpm catalog entry for both optional pg peer and pg development. Its real **published peer requirement** and dev qualification version may have different appropriate semantics; do not force both to use one exact recommended app install pin. The first writer manages app/dev *install fields* only and must refuse any catalog change that would indirectly mutate a packed peer. The Payments owner may separately qualify a change to split the peer and dev representation or approve a changed peer contract. Its current @types/pg 8.20.0 (versus Gateway 8.23.1) is outside the first selection, not a policy waiver.

**Exception and hold:** older self-consistent adopted catalog revisions are explicitly deferred adoption, *not* a kind/value mismatch waiver. For an actual selected-field mismatch require exact package path, name, kind, expected value, observed value, owner, reason and review trigger. No wildcard, broad overrides, silent expiry or catch-all suppression. Report approved exception separately from exact match.

## 6. Read-only comparison and controlled diagnostics

An offline check receives the explicit consumer root, local selection, exactly adopted **data catalog revision** and named target manifests/native pnpm catalog. It must not install, fetch, mutate, execute subprocesses, evaluate JavaScript configuration, repair or infer undeclared scopes. The selected catalog can come from a previously verified installed artifact or committed retained snapshot; no dependence on the current *latest* external revision.

Validate: (1) strict bounded schema and duplicate keys; (2) immutable catalog locator/content digest and compatibility with the checker; (3) literal target path containment, normalized path identity, symlink and workspace ownership; (4) selected direct pin or precise default/named catalog selector; (5) actual section and effective selected exact version; (6) exact active/stale exception; (7) sorted stable findings and concise human guidance. Distinguish unknown/invalid input from a genuine known drift. Preserve literal pin versus catalog: provenance in diagnostics. Do not claim a string match establishes peer or runtime compatibility.

A changed nonselected field is **not selected-field drift**. A candidate writer nevertheless uses exact whole-file SHA-256 preimages to avoid clobbering concurrent edits. A self-consistent older revision is Current *for its adopted revision*, with an optional separate upgrade-available message supplied by a non-CI updater; it must not cause failing offline checks. No false passing state from incomplete independent review, absent catalog data or a missing target.

No new public CLI, exit taxonomy or schema export is accepted by this document. Future minimal user operations are *compare selected state* and *propose an explicit reviewed update*; avoid featureful CLI scaffolding, auto-install, generic init wizards or global package discovery until the real consumer UX needs them.

## 7. Native pnpm projection and safe reviewed update

**No bootstrap cycle.** A frozen pnpm install must succeed from committed package.json, pnpm-workspace.yaml and lock before the Stack checker or optional data artifact is loaded. The normal manager input is a visible projection, not an installer hook. Check compares that native state *after* the exact approved data has been obtained through a trusted installed artifact or local retained snapshot. No pnpx latest, remote network check, global install or floating Git tag.

pnpm default and named catalogs support references in normal dependency sections, including peer and optional declarations. pnpm pack/publish substitutes catalog: with actual version/range strings; a library's actual packed peer requirement is a compatibility contract, not a proof by source token. Use [pnpm catalogs](https://pnpm.io/catalogs), and prove the exact consumer manager behavior rather than assuming that docs for later pnpm majors apply to the pinned pnpm 11 version.

**Candidate update (proposed process, no accepted public CLI):**

1. Owner chooses selected repo targets and an exact **approved next data catalog revision**, with provenance and content identity. Record the repo's actual main/PR head SHA, selection and manifest whole-file preimages, workspace YAML and lock hashes, packageManager pin, patch/build permissions and original peer kinds. Ignore unselected files.
2. Resolve the candidate revision independently of the consumer installation, in a disposable trusted tool context, verify its retained/published artifact. Compute a finite proposed change before any file writes. Refuse unknown release, conflicting profile, ambiguous selector or unsupported manager.
3. Stage only the local *adopted data revision*, selected direct package.json or native catalog entry, and manager-generated lock. Preserve unselected comments/quotes/order, scripts, @types, peer metadata, overrides, local patches, TS/parser islands, engine and lifecycle settings. Never silently migrate a repo's literal pins to catalog: or vice versa.
4. Prefer the native existing updater's support for package.json and pnpm-workspace.yaml, if proved with real PR artifacts. Build a minimal YAML/JSON editor only for a demonstrated missing projection: structure-preserving selected-field edits, bounded sources, duplicate/alias rejection and no generic rewrite DSL.
5. Let the repository's **pinned real pnpm**, preserving its **own existing** peer/engine/build/registry policy (which differs among Gateway, Payments and Foundation), generate the native lock under existing bounded process custody. Reject force, legacy-peer exceptions, homemade SAT resolution, guessed peer ranges, silently added build permissions or unchecked postinstall scripts.
6. Verify generated diff against a literal allowlist. Reject preimage/head change and unrelated manifest/lock side effects. A failed plan is discarded as disposable work; never blindly rebase/mutate a user's checkout or retry a write that might already have happened.
7. Open only one independent reviewable PR per repository, respecting its existing migration gates, required CI and human/owner approval. A partial rollout and old still-adopted revisions are normal; no fleet-wide commit, rollback, publish or auto-merge is implied.

**Peer admission stop:** Payments currently resolves both optional peer pg and development pg from one default catalog. A changed catalog key would modify both and potentially change the shipped public peer requirement. The first auto-writer **must refuse** that change; read-only observation is still valid. A separate Payments-owned peer/dev split or peer-contract change requires an explicit reviewed decision and real packed positive/negative consumer proof, without converting a compatible range to a fabricated exact global requirement.

**Security:** Never grant a central bot broad code execution by enabling unchecked Renovate postUpgradeTasks, shell commands, lifecycle scripts or deployment secrets. New GitHub App permissions, runner execution scope or cross-repo write authorization require their own review. Keep read-only checks offline and bounded, propagate only approved *data* decisions, verify exact branch/preimage state, and redact credentials from diagnostic output. Published revisions are immutable; a rollback is a **new** revision and new consumer proposal.

### 7.1 Central PR delivery: reuse existing updater or expose the gap truthfully

The organization has a maintained [shared Renovate preset](https://github.com/agent-teams-ai/.github/blob/main/renovate-config.json) with PR limits, security rules and intentional disabled cohorts. Its own [.github/renovate.json](https://github.com/agent-teams-ai/.github/blob/main/renovate.json) extends this preset. **But Gateway and Payments public main do not have an enrolled Renovate config**, and their sampled active fast-uri bump PRs were created by **dependabot[bot]**. A shared preset file is not proof of its actual installation or authority in these repositories.

[Renovate's npm manager](https://docs.renovatebot.com/modules/manager/npm/) can extract standard package.json and pnpm native catalog values, use the package manager to update lockfiles and share repository configuration. It does **not** thereby guarantee that bumping a custom *external catalog artifact* will synchronize all effective native manifest fields. [postUpgradeTasks](https://docs.renovatebot.com/configuration-options/#postupgradetasks) are blocked by default and privileged custom execution poses [supply-chain risks](https://docs.renovatebot.com/security-and-permissions/). Do not silently enable them or market a catalog-only PR as a complete update.

**Required bounded disposable spike before selecting an updater or data distribution:**
- Prove the actual configured updater/installation/permissions in **two candidate repos**. If Renovate is not enabled there, test it only in approved throwaway repos/branches, or select the already installed updater. Avoid modifying product migration PRs.
- One exact central selection change (real qualified package version or controlled fixture) must produce **two complete** candidate native package+lock diffs, one direct app and one native catalog case. An independent third enrolled repo with a deliberate hold remains unchanged. No invented vendor releases.
- Compare native output, accepted catalog identity, strict manager resolution, clean frozen install, no changes to unselected keys, token-free logs, peer/patch/build permission preservation, failure on stale base and actual PR-ready artifacts.
- If existing updater supports the bounded path without arbitrary commands, use it. Otherwise either label a manual-per-repo proposal route **interim** or seek separate owner approval for one tiny proposal adapter outside Stack. No daemon, fleet database, additional plugin system or timer is included.

Prevent Renovate and Dependabot from competing on the **same selected fields**, but allow each to own unrelated dependency updates. A security advisory may create a separate urgent candidate; never silently bypass a frozen owner compatibility or peer gate. Existing PR concurrency limits should avoid storming a fleet; no new global retry scheduler or silent self-healing.

**Acceptance:** central update success is measured by complete per-repository PRs and their retained manager/CI contracts, **not** by the central JSON change alone. When a proposal is blocked, report exact target and gate and leave that repository's previous adopted version untouched.

## 8. Two-phase real pilot, including original pg role pair

**Pilot A — user workflow first:** choose one already-observed **development-only** family, such as YAML, from two named real pnpm consumer main branches *after* refreshing the manifest/version evidence. Reuse existing native updater mechanisms first. A central approved changed version should produce two complete bounded PR artifacts (or prove and document why this isn't possible), each with its normal pinned manager and frozen lock. The goal is to prove the promised centralized update UX without first modifying a published library peer. Do not fabricate new YAML package releases just to create a demo.

**Pilot B — app/library adversarial proof (pg):**
- Gateway server has pg 8.23.1 in direct runtime dependencies and @types/pg 8.23.1 in development. Check direct install binding; a changed pg pin is gated by its existing PostgreSQL/transport/Node/build qualification.
- Payments Postgres adapter has optional peer pg + dev pg from a shared default pnpm catalog entry, selecting pg 8.23.1; @types/pg remains 8.20.0, with original pg-boss, Drizzle rc5 patch, peerDependenciesMeta and financial/security/driver gates retained. First compare **read-only at the current version**, inspect the actual packed peer, test allowed/negative installed consumers. An update coupled to a peer-range change **blocks** until the Payments owner separately approves and qualifies that contract.
- No common database adapter, runtime DI, SQL or production contract is created. No assumption that first app validation proves library compatibility. These are separate repo PRs only once their current owner gates are clear.

A YAML-only pilot cannot prove peer-role safety; the pg role-pair cannot by itself prove convenient fan-out to many repos. Both are needed for their different risks, but remain narrow, sequential admission slices—not a fleet-wide dependency migration.

The existing inventory sampled zero React/React DOM/Vite/Vitest/Jest/Playwright Testing Library direct declarations. A real frontend inventory and approved compatibility evidence are prerequisites for any React/Vite family claim. Get Modular's public Bun-rooted manifest is an explicit boundary: a pnpm-only implementation makes **no** Bun-native projection promise.

## 9. Test and qualification matrix — prove risk, not ceremony

| Level | Minimum positive evidence | Mandatory rejection |
| --- | --- | --- |
| Strict pure model | Exact install selection, immutable data revision, literal paths, deterministic stable diagnostics | Duplicate/unknown JSON fields, bad version grammar, unknown/missing revision or digest, target collisions, conflicting family selections |
| Offline check | Byte-for-byte unchanged observed files, zero installs/network, accurate Current/Drift/Unknown | Wrong adopted revision, wrong dependency kind or selected value, missing named catalog, path/symlink escape; a newer offered revision must **not** fail old self-consistent CI |
| Native manager | Exact pinned pnpm, literal and named/default catalog selection, frozen install and SRI lock | Bad selector/YAML, manager mismatch, unsupported lifecycle change, stale lock |
| Safe candidate plan | Exact preimages, finite diff, real manager-generated lock, unchanged unselected fields, discard failed stage | Concurrent edits to whole file/head, uncontrolled override/patch/peer side effects, pin mismatch, untrusted artifact, bot credential ambiguity |
| Packed app/library | Real compile/install/run on original role, packed peer manifest inspected | Changed public optional peer without owner decision, positive/negative peer qualification failures |
| Central delivery | One approved catalog change → two complete reviewable proposed PR artifacts; third repo deferred; existing updater installation proven | Only catalog pointer bumped, unavailable updater, privilege escalation, competing bots, PR storm, unknown/incomplete review shown as green |
| Recovery | Staging disposable, prior accepted revision installs offline and remains buildable when another repo is blocked | Broad fleet rollback, silently mutable old catalog, retry that overwrites a concurrent PR |

Reuse existing Foundation/Stack release gates and each consumer's real tests; add isolated tests for high-risk parser/path/peer/preimage policy, not a giant mock matrix. No real customer projects, live payment charges or secrets in tests. Node's native test runner remains; fast-check supplements it. A docs-only design PR proves none of the live E2E acceptance until those tests actually run.

Do not use unrelated architecture/composition changes to make CI green. Independent review must inspect exact final head and actual code/diffs after implementation; PR #458's ReviewRouter run reported **incomplete, 0/2 files reviewed** and must not count as review approval.

## 10. Bounded delivery, starting with proof before invention

**D0 — design decision:** settle data authority and independently versioned delivery form (immutable Git snapshot versus inert data artifact), initial strict selection/role boundary and qualified first family. Record options rejected and required source/provenance check. PR #458 remains design-only and draft pending independent review; no catalog name, new package, public CLI or release is authorized.

**P0 — disposable real updater spike:** inspect existing Renovate/Dependabot installation and exact permissions, native pnpm manager behavior, peer coupling and artifact update path. Prove one central change → two complete native candidate PR artifacts + third deferred; reject shell postUpgradeTasks/default permissions if unsafe. Preserve migration PRs. This is a decision prerequisite, not a hidden production rollout.

**I1 — minimal portable checker:** only after P0, implement strict catalog schema/identity, explicit consumer selection and read-only selected-field comparison in Stack's existing architecture-neutral package. One data authority remains independent of the checker release. Minimal meaningful rejection fixtures, no new CLI without approval.

**I2 — only missing candidate projection:** reuse native updater support where proven; otherwise the smallest safe exact-field JSON/pnpm YAML writer with whole-file preimages, real pnpm lock, bounded process execution and no broad repo mutation. Separate any new data artifact/release from Stack tool implementation and qualify each through its own approval/release route.

**I3 — two consumer qualification/rollout PRs:** Gateway/Payments pg read-only app/library proof and packed peer gates; an earlier development-only pilot proves cross-repo convenience. Wait for the owning migrations and refresh live main SHAs. Each consumer accepts independent CI, review and merge gates. No automatic fleet cutover, no React/Vite or extra manager claims.

**Stop condition:** if a complete proposal needs privileged arbitrary code, new daemon/coordinator, unverified YAML rewriting, or a surprise changed peer contract, reduce to a truthful manual proposal + offline checker with the limitation documented. Do not call the manual fallback automated centralized updates.

Original 350–600 handwritten mechanism LOC / 200–350 test LOC are **hypotheses for a minimal read-only checker only**, not for catalog publication, cross-repo bot, YAML preservation, library peer admission or all gates. Re-estimate after P0. Do not make a new package, general update DSL or separate service to satisfy an inaccurate LOC estimate.

## 11. Adversarial critique and actual review evidence

[Detailed critique and decision log](dependency-profiles-critique-2026-11-01.md) records the separate attack surfaces, evidence and remaining blockers. These were **self-review lenses**; no independent GPT subagents were available/executed. An actual automated ReviewRouter comment on PR #458 says *incomplete*: 0 of 2 files reviewed, provider exhausted retries. This is **not** an approval.

Six viewpoints were deliberately challenged:

1. **Architecture/DDD:** a catalog embedding allowed app/library dependency kinds duplicates consumer policy. Revision 2 gives the central data owner only selected install versions, keeping consumer roles/kinds and real peer contracts in the consumer.
2. **Release/version authority:** publishing a new Stack Toolchain for every pg/YAML bump couples unrelated technical tools and selections. Revision 2 distinguishes a neutral mechanism and independently versioned data authority, with a specific distribution decision gate.
3. **Package-manager/peer semantics:** an exact pnpm catalog value is not a published library peer-range proof; Payments uses one key for peer+dev. Revision 2 refuses an unreviewed coupled write, keeps @types and native islands intact, and requires real packed consumer evidence.
4. **Security/supply chain:** Renovate postUpgradeTasks are privileged and disabled by default; GitHub App permission and immutable data provenance matter. Revision 2 requires least privilege, real installed updater proof and no arbitrary scripts in central PR generation.
5. **UX and scale:** the original specification only measured a correct catalog/drift check, not actual propagation. Revision 2 makes *two complete native PRs from one central revision* the acceptance criterion, with explicit Current/Proposed/Blocked/Deferred outcomes.
6. **Recovery/maintainability:** fleet-wide atomicity, auto rollback, background schedulers and generic manager solvers are rejected. Revision 2 uses exact preimages, disposable staged proposals and one owner PR per repo.

**Review verdict:** the architecture is viable only after choosing data ownership and proving delivery/peer gates. This design remains not accepted and not implemented. The next mandatory review is an actual independent technical reviewer of the final docs/head, then a real disposable cross-repo updater spike before coding public mechanisms.

## 12. Open owner decisions and no-go boundaries

| Decision | Bounded recommendation | Evidence gate before code |
| --- | --- | --- |
| Version data ownership | One independent catalog authority; Stack owns portable mechanism, Foundation only optional policy | Owner selects distribution and immutable identity, with no second desired-version table |
| Distribution B vs C | Immutable central Git + retained snapshot, or independent inert data artifact; **no name chosen** | Two-repo updater E2E and offline integrity/provenance/readback |
| Catalog schema | Strict JSON, one exact install family and versioned schema; no YAML authoring sugar | Duplicate-key/path/field conflict tests and actual consumer read |
| Selected kind | Consumer explicitly owns direct/development/peer role and projection, catalog does not force role | Gateway app + Payments library role/published peer tests |
| Controlled rollout | Selected revision per repo; newer offered revision is an informational upgrade, not failing CI | Old-but-consistent repo and exact exception tests |
| Proposal channel | Reuse existing updater (Renovate/Dependabot) and pnpm if proven; no arbitrary postUpgradeTasks | Actual installation/permission and complete PR artifact proof |
| Extra projection code | Only measured missing pnpm/manifest delta; exact preimages and minimal edits | Native manager before/after fixtures and stale write rejection |
| Additional families | Frontend/React, other managers and general full-stack profiles deferred | Separately authorized real consumers and compatibility evidence |

Open items are genuine design decisions, **not accidental omitted implementation details**. One central catalog PR does not confer privilege to install software or merge consumer changes. Accepted ADRs remain untouched; a later implementation touching public contract/package graph needs its own accepted successor and release qualification.

Until then: specification only, existing migrations independent, Token excluded, PR #458 draft, no runtime/profile/CLI/package support or automatic update is being claimed.
