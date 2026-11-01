# Dependency profiles: implementation specification and bounded pilot

**Status:** PROPOSED DESIGN ONLY, revised 2026-11-01 — not accepted, implemented, published or qualified. [Deep adversarial critique and decision log](dependency-profiles-critique-2026-11-01.md). PR #458 ReviewRouter reported incomplete coverage (0/2 files); this is not independent review or approval.
**Snapshot date:** 2026-11-01.
**Owner candidate:** the existing independent Stack Toolchain package in Engineering Foundation.
**Change boundary:** specification only. This document authorizes no new package name, public command, profile capability, release, automatic dependency update, or migration of consumer repositories. Token is excluded. Existing Toolchain migration and delivery/E2E PRs are independent and must not be edited by this work.

## 1. Problem, concrete user journey and success criteria

The problem is version-selection duplication across independent repositories. A native workspace catalog solves repetition *within* one pnpm workspace; it does not distribute one reviewed version choice across Gateway, Payments and other independently released projects. Consumers must keep ordinary vendor imports and their own runtime/peer/CI guarantees, with no umbrella runtime dependency.

**Desired maintainer experience (design target, NOT implemented):** explicitly enroll a literal project/manifest and one small dependency family once; review one central choice of an exact vendor version; receive a separate complete proposal PR per eligible enrolled repository; let each repo independently qualify and merge that proposed change. One central choice is not a global force-upgrade or multi-repo transaction.

The central change must update the actual selected package.json or manager-native default/named catalog **and manager-owned lockfile**, not only an abstract catalog pointer. Successful end-to-end delivery requires two complete consumer PR artifacts from one central approved revision, with unchanged out-of-scope fields, exact source identity, normal frozen-install and critical consumer gates. A single generated JSON report or unverified Renovate config is insufficient.

**Small user-facing status vocabulary:**

| Status | Meaning | Action |
| --- | --- | --- |
| Current | Selected manifest/native catalog and lock agree with the **consumer's adopted** immutable revision | None |
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

**Identity:** separate schema version, immutable *catalog* data revision, SHA-256 of exact retained/package artifact bytes outside the hashed document, exact vendor version, installed Stack checker version, consumer's adopted revision and newer offered revision. A moving branch/tag and a "latest" lookup are never a CI authority. Changing the catalog makes a new immutable revision, *not necessarily a new Stack Toolchain release*. Verify release provenance/physical artifact against the selected reference before reporting that data is available.

**Consumer selection:** explicit inert input maps exact repo-relative package.json paths to named catalog families/packages, actual dependency kinds and the literal/default/named-catalog read surface. It pins an exact catalog revision plus content digest and may select only part of the catalog. It cannot execute code, load JavaScript config, follow symlink escapes, traverse parents, select duplicate path identities or expand globs. The consumer, not catalog, decides whether a field is dependencies, devDependencies, peerDependencies or optionalDependencies.

**Peer contract separation (critical):** Gateway uses a direct runtime pg 8.23.1 pin. Payments currently uses one default pnpm catalog entry for both optional pg peer and pg development. Its real **published peer requirement** and dev qualification version may have different appropriate semantics; do not force both to use one exact recommended app install pin. The first writer manages app/dev *install fields* only and must refuse any catalog change that would indirectly mutate a packed peer. The Payments owner may separately qualify a change to split the peer and dev representation or approve a changed peer contract. Its current @types/pg 8.20.0 (versus Gateway 8.23.1) is outside the first selection, not a policy waiver.

**Exception and hold:** older self-consistent adopted catalog revisions are explicitly deferred adoption, *not* a kind/value mismatch waiver. For an actual selected-field mismatch require exact package path, name, kind, expected value, observed value, owner, reason and review trigger. No wildcard, broad overrides, silent expiry or catch-all suppression. Report approved exception separately from exact match.

## 6. Read-only comparison and controlled diagnostics

An offline check receives the explicit consumer root, local selection, exactly adopted **data catalog revision** and named target manifests/native pnpm catalog. It must not install, fetch, mutate, execute subprocesses, evaluate JavaScript configuration, repair or infer undeclared scopes. The selected catalog can come from a previously verified installed artifact or committed retained snapshot; no dependence on the current *latest* external revision.

Validate: (1) strict bounded schema and duplicate keys; (2) immutable catalog locator/content digest and compatibility with the checker; (3) literal target path containment, normalized path identity, symlink and workspace ownership; (4) selected direct pin or precise default/named catalog selector; (5) actual section and effective selected exact version; (6) exact active/stale exception; (7) sorted stable findings and concise human guidance. Distinguish unknown/invalid input from a genuine known drift. Preserve literal pin versus catalog: provenance in diagnostics. Do not claim a string match establishes peer or runtime compatibility.

A changed nonselected field is **not selected-field drift**. A candidate writer nevertheless uses exact whole-file SHA-256 preimages to avoid clobbering concurrent edits. A self-consistent older revision is Current *for its adopted revision*, with an optional separate upgrade-available message supplied by a non-CI updater; it must not cause failing offline checks. No false passing state from incomplete independent review, absent catalog data or a missing target.

No new public CLI, exit taxonomy or schema export is accepted by this document. Future minimal user operations are *compare selected state* and *propose an explicit reviewed update*; avoid featureful CLI scaffolding, auto-install, generic init wizards or global package discovery until the real consumer UX needs them.

## 7. Native package-manager projection and safe reviewed update

**Projection rule:** pnpm-workspace.yaml, literal package.json specs, and the consumer's selected Stack release are concrete tool inputs derived from one reviewed selection. Keep consumer-owned YAML comments and unrelated keys intact; update only the exact selected entries. A direct Gateway pg pin is valid; a Payments catalog: declaration remains valid. Do not convert all workspaces to one style.

pnpm supports default and named catalogs and resolves catalog: in dependency, development, peer and optional fields. When publishing a library, pnpm's pack/publish process replaces catalog references with real ranges. This is precisely why the packed peer contract must be inspected; do not treat a catalog: token itself as the shipped peer range. See [pnpm catalogs](https://pnpm.io/catalogs) and [pnpm 11 workspace documentation](https://github.com/pnpm/pnpm/blob/main/pnpm11/docs/workspaces.md).

**Bootstrap invariant (critical):** pnpm reads committed package.json and pnpm-workspace.yaml **before** Stack can be installed in a fresh consumer. Therefore those literal projected inputs must remain sufficient for a normal frozen install with zero execution of a catalog checker. A post-install read-only check validates them against the exact installed Stack artifact. For an explicit upgrade, the owner separately stages and verifies an exact, already-qualified candidate Stack artifact in a disposable tool context **before** changing consumer YAML/manifests or asking pnpm to resolve a new lock. No self-hosting dependency cycle, implicit network fetch during check, or reliance on a future unsupported package subpath is permitted. A project that cannot install the required already-selected Stack version reports an installation blocker; it never substitutes another release.

**Explicit update proposal (no accepted public CLI):**

1. Owner chooses the named consumer target(s), exact candidate Stack release and catalog digest, and authorized selected packages. Check qualification/provenance of that artifact through the existing release route. Do not select "latest", query an ambient registry or silently upgrade Stack.
2. Observe and record target branch SHA, selected manifest/blob hashes, selection file hash, pnpm-workspace.yaml hash if affected, existing lock hash, packageManager pin, existing patches, and the original expected dependency kinds. Inspect whether another migration PR has changed them.
3. Resolve the candidate catalog using the exact approved artifact; verify digest and schema. Compute the **finite proposed diff** first. Refuse contradictory target/profile selections, unapproved peer contract changes, missing targets, an unqualified role or stale input.
4. Prepare changes only in a disposable checkout/candidate branch with optimistic whole-file preimage checks. Stage minimal selected-field edits to the selection record and native manager/manifest projection. Leave all unselected keys, overrides, peer metadata, @types, patches, lifecycle permissions, scripts and native guards unchanged.
5. Run the **actual consumer-pinned pnpm** to generate its lockfile under its existing strict settings. Installation and peer validation are normal pnpm responsibilities; there is no homemade solver, guessed peer range, force/legacy-peer escape or handwritten lock resolution. Manager execution is an explicit effect and uses the existing bounded process boundary. If the manager cannot validate, fail the plan with diagnostic evidence.
6. Recheck selected fields, exact manager pin, expected prior inputs, generated lock, shipped peer range and bounded diff. Reject edits outside the approved set. Keep the staged diff reviewable and only then prepare **one PR for that repository**.
7. Consumer CI supplies its existing frozen install, compile, TypeScript/source contracts, Node compatibility and real packed positive/negative consumer tests. Gateway's PostgreSQL/transport gates and Payments' financial/security/driver admission gates remain independently required when relevant. A lock diff by itself proves nothing about runtime safety.
8. If any preimage or branch head moved, refuse and calculate a new plan against fresh inputs. A staging failure may leave disposable local files, which are discarded; there is no claim that multiple filesystem writes or several repositories commit atomically.

Release/adoption ordering: first publish and independently qualify a changed Stack artifact if such a release is authorized; only then use explicit consumer PRs. Consumers can remain on older approved catalog revisions while their owner gates are active. A fleet dashboard or reconciler is out of scope.

**Important peer-risk gate:** Payments presently uses catalog: for **both** pg peer and dev. Updating its one pg catalog value can also change the **published peer requirement**. Do not equate app version convergence with the library's legitimate peer compatibility range. Any changed packed peer range needs a separate library-owner review and genuine positive/negative installed consumers. If its owner requires a wider compatible peer range than the app's exact selected version, keep that range under the library's explicit peer contract and redesign that one projection with evidence; do not manufacture a caret range or force shared exact peers.

## 8. Pilot: pg, two different real roles

**Precondition:** the owners' relevant current migration and admission gates have completed. At that moment refresh both main SHAs and all exact inputs; the table above is historical evidence only.

**Application:** Gateway services/account-gateway/package.json, pg in dependencies at 8.23.1, @types/pg 8.23.1 development untouched. A check can prove direct selected-value and dependency-kind equality without modifying any runtime. An authorized candidate update must prove its real PG qualification and retained service behavior.

**Library:** Payments packages/payments-postgres/package.json plus root pnpm-workspace.yaml, pg in optional peer + dev with catalog: resolving to 8.23.1. Retain @types/pg 8.20.0, peerDependenciesMeta, pg-boss, Drizzle rc5 patch, original manager settings and SDK consumer checks. Inspect what the packed package declares as peerDependencies; qualify a real consumer that supplies a permitted pg, and a negative consumer that supplies an incompatible pg. Do not infer the contract solely from pnpm's workspace display.

First pilot checks selection + projection at **current existing** version; changing pg itself is a separate owner-approved compatibility task and is not part of design acceptance. A YAML-only development pilot would be simpler but cannot qualify peer-role behavior, so it is a fallback for technical spikes, not the main acceptance case.

## 9. Test and qualification matrix (only material risks)

| Level | Required positive | Required rejection/evidence |
| --- | --- | --- |
| Pure model | Identical revisions and explicit app/library targets; deterministic findings | Invalid/duplicate JSON fields, unknown schema/revision, conflicting selections, missing target, kind mismatch and exact exception violations |
| pnpm adapter | Direct literal pg and named/default catalog: resolve as selected, untouched nonselected fields | Missing catalog entry, wrong named selector, malformed YAML, path escape/symlink, changed original input and unsupported manager |
| Read-only checker | Before/after byte hashes equal on all observed files; no subprocess/network | Drift must not repair or install; missing physically installed candidate is explicit failure |
| Explicit candidate update | Limited manifest+selection+manager-generated lock diff using pinned pnpm; repeat with unchanged inputs yields no uncontrolled change | Stale branch/file preimage, peer conflict, unapproved peer-kind/value change, widened patch/override or lifecycle diff, manager failure |
| Packed library / app | Native compile, install and E2E using actual consumer roles; original critical regression gates | Invalid packed peer consumer, strict peer failure, guard/island preservation, offline/frozen mismatch or unsupported update |

Reuse existing tests and release checks. Add isolated logic tests only for high-risk conflict/freshness/role decisions, then real process/packed tests for the contract; do not create a huge synthetic test matrix or claim broad framework support. Do not execute real-money operations or use live secrets. The existing Stack release qualification and full CI apply when implementation touches source; **this documentation PR is not an implementation qualification**.

## 10. Bounded delivery sequence (future, requires owner acceptance)

**Phase D0 — design admission:** review this proposal against ADR-0064, Foundation workspace-declaration v1, package-manager docs and outstanding Toolchain PRs. Decide the pending identities and first exact profile without changing any implementation. Freeze the per-consumer current-main byte ledger when actual work begins.

**Phase I1 — one portable data slice:** add strict JSON schema, one pg catalog selection and a pure selection/compare kernel to the existing Stack package; include packaged revision integrity and minimal rejection tests. Do not add a frontend family.

**Phase I2 — read-only integration:** one explicit consumer selection format, physically installed catalog validation and limited pnpm/manifest read adapter. Provide read-only drift to opt-in Foundation policy through an existing suitable seam, without a second catalog or mandatory Foundation dependency. No new public command until interface acceptance.

**Phase I3 — explicit candidate planner:** finite diff, exact preimages, minimal YAML/manifest projection and pinned pnpm lock generation in a disposable checkout. No cross-repo coordinator or rollback promises. Add manager/peer failure E2E.

**Phase I4 — real consumer qualification:** rebase on finished migrations, apply to Gateway and Payments as **separate** scoped PRs, qualify both current-version read-only cases and packed app/library consumers, review actual diffs, publish/roll out only through their owners' normal gates. No automatic vendor upgrade.

**Stop condition:** if the existing version catalog/peer contracts cannot be preserved without extra engine/waiver/system infrastructure, reduce the pilot to read-only pg drift rather than introducing global overrides, an installer or a homegrown dependency solver.

Estimated **candidate** after reuse: about 350–600 handwritten mechanism LOC, 200–350 meaningful rejection/integration test LOC, 40–100 catalog/docs LOC, plus bounded per-consumer wiring and manager-generated lock diffs. This is a sizing hypothesis, not a measured LOC commitment; actual pnpm YAML preservation and packed-peer qualification could increase it. Scope increases require explicit evidence.

## 11. Three architecture challenge passes performed for this proposal

These are **self-review lenses**, not claims of independently executed LLM subagents or accepted external review.

**Pass A — single-source-of-truth and Clean Architecture.** Failure mode: a second Foundation catalog, auto-discovery or full-stack wrapper replaces one set of repeated pins with competing policy. Resolution: data authority remains inside Stack; Foundation only consumes read-only findings; consumer projections and lock keep their separate true tool roles; business/architecture rules stay out.

**Pass B — package-manager and peer contract.** Failure mode: a flat pg bump silently narrows a publishable library peer range, erases @types/pg differences, or treats pnpm catalog syntax as runtime compatibility. Resolution: explicit app/library/kind selection, preserve direct versus catalog placement, inspect packed output, refuse unapproved peer changes, require real positive/negative consumers and exact manager.

**Pass C — safety, bootstrap, scale and maintainability.** Failure mode: catalog revisions silently float, a fresh pnpm install needs Stack before it can obtain Stack, local edits are overwritten, and a fleet-wide update appears atomic. Resolution: committed manager-native projections bootstrap the initial install; upgraded artifacts are staged separately; immutable digest, finite literal targets, physically installed release, optimistic preimages, staged diff and one owner PR per repo. Prefer one small feature and existing process/CI owners over scheduler, installer and remote registry.

These challenges do **not** replace the independent technical review required before any later code merge. Obtain that review against the exact implementation head and fix material findings in its own PR.

## 12. Owner decisions still open

| Decision | Recommended bounded choice | Acceptance required before |
| --- | --- | --- |
| Catalog format | Strict JSON + first versioned schema; no YAML authoring sugar initially | Writing/claiming a schema |
| Placement and distribution | Data shipped in the already-existing Stack release; exact package release + catalog digest | Any registry/public capability claim |
| Granularity | Single opt-in pg family, literal package paths and app/library/development distinction | Public selection contract and consumer adoption |
| Consumer selection identity | Strict JSON, exact installed Stack release and packaged catalog SHA-256; path/name not chosen yet | Creating consumer config files |
| Exceptions | Exact one-field record with owner, reason and review trigger, no broad ignore | An exception interface |
| Safe update | Disposable candidate with strict preimages and exact pnpm; one PR per repo; no new public command chosen | Implementing a writer |
| Later frontend families | Separate real React/Vite consumer inventory and compatibility qualification | Any frontend support wording |
| Later managers and standalone catalog | Defer until a proved consumer exists and release coupling is a real problem | Designing adapters/artifacts |

The owning review may revise these proposals. Until then, this is documentation of a decision candidate, **not permission to implement, merge, publish, expand support or modify active migration PRs**.
