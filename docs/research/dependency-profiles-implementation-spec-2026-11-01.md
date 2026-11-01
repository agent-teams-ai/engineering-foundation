# Dependency profiles: implementation specification and bounded pilot

**Status:** PROPOSED DESIGN ONLY — not accepted, implemented, published, or qualified.
**Snapshot date:** 2026-11-01.
**Owner candidate:** the existing independent Stack Toolchain package in Engineering Foundation.
**Change boundary:** specification only. This document authorizes no new package name, public command, profile capability, release, automatic dependency update, or migration of consumer repositories. Token is excluded. Existing Toolchain migration and delivery/E2E PRs are independent and must not be edited by this work.

## 1. Problem and intended outcome

Many independent projects select the same external libraries but repeat version decisions. A workspace catalog already removes repetition inside one repository; it does not resolve selection drift between repositories. Stack Toolchain already centralizes compiler/linter/formatter versions and technical presets. The proposed extension centralizes **opt-in selections for ordinary application and development libraries** without importing them through Stack, changing their owner, or replacing the package manager.

The intended user workflow is: explicitly enroll a real package path and a small family; review one published catalog identity; see precise read-only drift; explicitly stage a limited version update; regenerate the ordinary lock with the repository's exact manager; review and qualify a separate PR in each affected repository. No background changes or invisible changes to runtime behavior.

**Success is narrow:** the same chosen catalog revision can be checked against Gateway's direct runtime declaration and Payments' library peer + development declarations, with appropriate differences preserved. Success is **not** proof of a common PostgreSQL abstraction or compatibility for an unrelated framework.

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

## 3. Explicit invariants and non-goals

1. **One version-selection owner:** only Stack's data catalog selects governed external package versions. A consumer-local literal manifest or native manager catalog is a required projection for the package manager, not another independent policy catalog. Catalog/profile identity must be reviewable and immutable for a release.
2. **Opt-in and finite:** no ambient discovery, automatic scans of arbitrary sibling repos, broad globs, implicit organization enrollment, or full-stack profile for every app. Each maintained target is a literal repository-relative package.json path selected by the consumer.
3. **Direct vendor ownership:** applications directly declare their runtime packages; libraries retain genuine peer constraints, their own development qualification pins, and public direct vendor import paths. No umbrella package, re-export, forced shared adapter, runtime injection, React transitives, hidden override, or dependency-kind relocation.
4. **Existing owners remain:** Stack owns the portable catalog, comparison and proposed projection/planning algorithm; Foundation may read drift findings as opt-in repository policy, never duplicate the catalog. node-or-bun remains only the bounded process mechanism. Product financial/security policy, architecture topology, source-import rules, release governance, and manager lock resolution stay with their current owners.
5. **No generated truth substitution:** manager-owned lockfile is the transitive graph and integrity/SRI record, not Stack's catalog. A selected version string does not establish peer compatibility or runtime qualification. Catalog does not resolve peers, install dependencies, choose a test runner, or change scripts.
6. **Preserve external policy:** overrides, patchedDependencies, local native parser/TS6 islands, packageManager, engines, package lifecycle permissions, types, nonselected catalog entries, JavaScript config, and tests remain consumer-owned. Node's existing test runner remains; fast-check is a supporting test library, not a replacement.
7. **Only staged writes:** check/status is genuinely read-only. An explicitly authorized update prepares a finite, exact-preimage diff in a disposable candidate checkout. Never silently repair, commit, publish, open/merge another repository PR or claim atomic multi-repository behavior.

Outside v1: React/Vite/Vitest/Jest/Playwright/Testing Library (no qualified direct frontend consumers in the supplied sample), Bun/npm/Yarn projection adapters, automatic stack detection, global policy overrides, generic workspace migration, transitive optimizer, a new hosted registry, a new framework, and a new public CLI decision.

## 4. Ownership and Clean Architecture slice

Use **one cohesive Stack feature**, separate from existing toolchain-execution, with minimal ports:

| Layer | Responsibility | Explicitly excluded |
| --- | --- | --- |
| Pure selection model | Strict schema, catalog identity, package/role/kind mapping, exact selection, deterministic normalized drift records, conflict and exception checks | File IO, pnpm execution, peer solving, product rules |
| Application cases | Compare declared targets against immutable selections; calculate an explicit bounded update plan; validate baseline and approval | Ambient discovery, unattended mutation, multi-repository coordinator |
| Input/output adapters | Read strict JSON and exact literal manifest paths; inspect pnpm native catalog **without executing JS**; write a candidate finite patch; delegate lock generation to selected exact pnpm and capture result | Business imports, unrelated source rewrites, Foundation-specific policies |
| Composition | Wire filesystem and process ports using Stack's existing conventions and node-or-bun where subprocess control is needed | Second process manager, dependency-injection framework, event bus, workflow engine |

Keep interfaces at real IO boundaries. No service locator, package-per-class structure, DDD aggregates for a data-selection checker, or per-repo copy of core comparison logic. One small feature directory and direct pure functions are adequate. Use TypeScript .ts and existing strict tooling. If YAML parsing needs a runtime library, qualify the minimal deterministic parser dependency in Stack itself; do not borrow undeclared consumer transitive dependencies.

Existing Foundation workspace.dependency-declarations is a **different** capability: it verifies workspace rules and package placement in a repository. It is not an alternative cross-repository catalog, and a new drift result must not weaken its independent contract or accepted exception policy.

## 5. Candidate data contracts — illustrations, NOT public APIs

**Catalog**: a strict JSON document owned and released with Stack, with a versioned schema. Recommend embedding the first bounded catalog in the existing Stack release; defer an independent data artifact until an actual release/use case requires it. No new package identity or public subpath is accepted by this document.

Candidate conceptual JSON (illustrative names and shape only):

~~~json
{
  "schemaVersion": 1,
  "families": {
    "postgres-client": {
      "selections": { "pg": "8.23.1" },
      "allowed": {
        "application": ["dependencies"],
        "library": ["peerDependencies", "devDependencies"]
      }
    }
  }
}
~~~

A real schema must specify exact field grammar, unknown-field rejection, duplicate-key rejection, unique family/package identifiers, exact selected-version syntax, and deterministic serialization. No executable configuration, conditionals, local callbacks, new installer scripts or semver guessing. An optional public preset reference is **data**, not an instruction to import another package at runtime.

**Identity**: keep three distinct concepts:
- catalog schemaVersion: shape/compatibility of the data;
- exact Stack package release version: distribution and packaging provenance;
- catalog content identity: SHA-256 over the **exact packaged UTF-8 catalog bytes** (the digest is recorded outside the hashed document to avoid self-reference).

Do not conflate these with selected vendor package versions, manager lock integrity, or compatibility evidence. Any catalog byte change yields a new digest and a reviewed Stack release. The same stable digest can be checked by a consumer installed from an already qualified artifact. A standalone data artifact is a deferred alternative, not a second simultaneous authority.

**Consumer selection**: consumer-owned, strict-JSON, explicitly enabled mapping from exact maintained package.json paths to the selected Stack catalog identity and named family. This is a candidate contract, not an agreed filename or published feature. A consumer can select only a subset of the catalog. Paths cannot be absolute, traverse above root, escape through symlinks, or resolve outside the approved workspace; targets must be unique and materialized. Do not expand glob patterns or depend on package-name guesses. Each target declares its actual role and selected dependency kinds. Mismatched role/kind or duplicate conflicting selections reject.

For illustration, Gateway selects its server package as application/dependencies/pg; Payments selects packages/payments-postgres/package.json as library/peerDependencies+devDependencies/pg, preserving its existing default catalog:. The root may remain unselected. This does not instruct either team to change its manifest.

**Per-repository exception**: only for a selected literal field, identify exact target path, package, dependency kind, expected selected value, retained observed value, responsible owner, reason, and a mandatory review trigger (for example next selected catalog revision). Reject wildcard packages, unbounded waivers, silently expired/triggered exceptions and a changed observed value. Report an active approved exception as such, never as matching selection. An unselected field needs no exception.

Do not introduce an exception merely because Payments uses @types/pg 8.20.0 while Gateway uses 8.23.1; @types/pg is outside the first pg-only selection. Keep the deliberate type and native islands in their existing authority. If later included, its difference requires separate qualification and an explicitly reviewed selection or exception.

## 6. Read-only comparison semantics

A compare receives explicit consumer root, its selection document, the **physically installed exact Stack package**, the corresponding catalog bytes, and only named target manifests/native pnpm workspace data. It performs no install, network access, file write, script execution, source JavaScript evaluation, repair or remote checkout.

It validates in this order:

1. Input readability, bounded size, strict syntactic parsing and schema version; unknown or duplicate governed fields reject, not partial-pass.
2. Installed Stack identity and packaged catalog digest against the consumer selection; a missing artifact or incompatible/new revision is **unavailable/mismatch**, not a transparent fallback to a different global install.
3. Named target path containment, package role, packageManager identity and actual finite workspace membership (where a workspace is involved).
4. Each selected package field in dependencies/devDependencies/peerDependencies/optionalDependencies; resolve only explicit default/named pnpm catalog selectors supported by the selected manager. A missing/ambiguous selector is a finding.
5. Exact selected version/range string and declared dependency kind; peer + development duplicates are permitted only as an explicitly selected library pairing that follows existing owner policy. Do not move kinds automatically.
6. The optional exact exception record; report its state and any expired/review-triggered case separately.
7. Emit stable ordered findings with target path, package, kind, expected, observed, catalog release/digest, and reason. Never include tokens or broad source/file dumps.

Report **selected-field drift** separately from **whole-file freshness**: unrelated manifest fields must not become selected-field drift merely because the file hash changed. For an update, however, whole-file SHA-256 preimages are mandatory to prevent overwriting concurrent edits.

Suggested findings (provisional names, not stable public identifiers): invalid-input, missing-target, unknown-revision, selector-drift, selected-value-drift, dependency-kind-drift, conflicting-profile, active-exception, stale-exception, and preimage-changed. Machine-readable error taxonomy and command surface require owner acceptance and conformance before being called public.

## 7. Native package-manager projection and safe reviewed update

**Projection rule:** pnpm-workspace.yaml, literal package.json specs, and the consumer's selected Stack release are concrete tool inputs derived from one reviewed selection. Keep consumer-owned YAML comments and unrelated keys intact; update only the exact selected entries. A direct Gateway pg pin is valid; a Payments catalog: declaration remains valid. Do not convert all workspaces to one style.

pnpm supports default and named catalogs and resolves catalog: in dependency, development, peer and optional fields. When publishing a library, pnpm's pack/publish process replaces catalog references with real ranges. This is precisely why the packed peer contract must be inspected; do not treat a catalog: token itself as the shipped peer range. See [pnpm catalogs](https://pnpm.io/catalogs) and [pnpm 11 workspace documentation](https://github.com/pnpm/pnpm/blob/main/pnpm11/docs/workspaces.md).

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

**Pass C — safety, scale and maintainability.** Failure mode: catalog revisions silently float, local edits are overwritten, and a fleet-wide update appears atomic. Resolution: immutable artifact digest, finite literal targets, physically installed release, whole-file optimistic preimages for apply, staged diff and one owner PR per repo. Prefer one small feature and existing process/CI owners over scheduler, installer and remote registry.

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
