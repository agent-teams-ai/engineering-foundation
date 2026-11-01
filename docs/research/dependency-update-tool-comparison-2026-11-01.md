# Ready-made dependency update tooling: real-world comparison for independent repositories

**Date:** 2026-11-01. **Status:** research and implementation-option evaluation only. This is not a completed cross-repository updater E2E, a configuration release, a public dependency-profile API or a policy-adoption decision. No client or Toolchain migration PRs are changed. Companion design: [dependency profiles specification](dependency-profiles-implementation-spec-2026-11-01.md) and [adversarial risk review](dependency-profiles-critique-2026-11-01.md).

## 1. Decision summary

**Preferred first experiment: hosted Renovate + one shared Git-based policy preset + native pnpm catalogs and lockfile generation + existing per-repository CI, while retaining GitHub Dependabot security alerts/updates with one explicitly assigned security-PR owner.** The hosted Renovate GitHub App is currently free for public and private GitHub repositories; validate its actual GitHub App installation and scope before any repository opt-in. A shared preset is already authored in agent-teams-ai/.github, but its existence does **not** prove that an app is installed in Gateway, Payments or Orchestrator.

**Do not implement a new Stack catalog, new npm artifact, generic dependency solver, cross-repository planner or updater as the first step.** First prove that a centrally maintained Renovate policy can achieve the desired observable behavior. If it cannot synchronize one exact target version as intended, distinguish that genuine gap from its already-supported PR, package-manager and lockfile work. A *small opt-in read-only check* or an *explicit release-policy data seam* could later be justified; a new package or service is not automatic.

**Decisive uncertainty:** Renovate packageRules.allowedVersions is officially a *filter* for version candidates, not a guarantee that an older repository will be downgraded or that a central preset change produces a PR for every consumer. rangeStrategy=pin governs manifest range representation; it is also not a cross-repository exact-target transaction. Shared presets can be Git-tagged or follow the default branch, with different change-control consequences. Do not claim exact-pin fleet convergence without an actual updater result.

**If exact cross-repository synchronization turns out not to matter:** Renovate as a normal *compatible-version maintenance* bot with a shared allowed-version policy is probably the complete solution. Every project can remain on an older reviewed version until its own CI/owner approves the newer candidate. This is deliberately easier and safer than enforcing identical resolved transitive graphs or pushing all repositories to the same release immediately.

## 2. Requirements; what the result must do

| Requirement | Meaning in this platform | Failure |
| --- | --- | --- |
| Cross-repo policy reuse | One reviewed place governs package-family update eligibility for opted-in independent repositories | Copy-paste desired version or generic config separately into each repo |
| Complete proposals | Each relevant consumer PR changes actual direct package.json or pnpm-workspace.yaml catalog values **and manager-generated lock**, not only policy pointer | Bot updates only a sidecar/artifact while normal frozen CI remains stale |
| Native ownership | pnpm 11 manages its own graph/SRI/peer checks, library publishes own peers, direct imports remain | Custom solver or synthetic umbrella runtime dependency |
| Independent adoption | Each app/library may defer, pass actual E2E, fail peer qualification or refuse a security-sensitive update | Global forced merge or blocked old-but-consistent CI |
| Safety | No arbitrary privileged update scripts; scoped app access; ordinary required CI, real review and source/provenance evidence | Bot silently executes untrusted repo code or rewrites patch/build policy |
| No PR noise | One chosen family changes only opted-in affected fields; unchanged selections produce no PR | Empty catalog revision churn or unrelated root updates |
| Future maintainability | Small config surface, explicit source authority, no new multi-repo coordinator or background state database | A large custom platform to patch a normal package-manager feature |

Four distinct goals must never be conflated: **discover the latest upstream version**, **limit allowed versions**, **recommend one exact version**, and **force all adopted projects to use that version immediately**. The first two have mature off-the-shelf support. The third requires qualification of the policy mechanics. The fourth conflicts with per-consumer owner authority and is not the desired automatic behavior.

## 3. Verified public GitHub observations

- Existing organization policy: https://github.com/agent-teams-ai/.github/blob/main/renovate-config.json — config:best-practices, dependency dashboard, PR/branch/hour limits 5/7/2, Oxc grouping, Node types on 24.x and disabled automated Docs Cohort updates. The organization's own https://github.com/agent-teams-ai/.github/blob/main/renovate.json extends local>agent-teams-ai/.github:renovate-config.
- Gateway public root https://github.com/agent-teams-ai/account-gateway/blob/main/package.json uses Stack 0.1.1, Foundation 3.0.0 and pnpm 11.28.2; the server https://github.com/agent-teams-ai/account-gateway/blob/main/services/account-gateway/package.json has literal pg 8.23.1 under runtime dependencies and @types/pg 8.23.1 dev. Its workspace YAML currently has no dependency catalog.
- Payments root https://github.com/agent-teams-ai/payments-sdk/blob/main/package.json uses pnpm 11.25.0 and Stack/Foundation 0.1.1/3.0.0. Its workspace https://github.com/agent-teams-ai/payments-sdk/blob/main/pnpm-workspace.yaml selects yaml 2.9.0, pg 8.23.1 and @types/pg 8.20.0, with strict peer/build/catalog rules and a Drizzle patch. The payments-postgres library declares pg both as optional peer and development reference to the **same catalog entry**.
- Orchestrator root https://github.com/agent-teams-ai/agent-teams-orchestrator/blob/main/package.json uses pnpm 11.18.0, Foundation 1.7.2 (no root Stack 0.1.1), and https://github.com/agent-teams-ai/agent-teams-orchestrator/blob/main/pnpm-workspace.yaml has yaml 2.9.0. It is a candidate **disposable snapshot**, not a qualified new Stack-profile consumer.
- Public main tree searches of Gateway and Payments found neither .github/renovate.json nor .github/dependabot.yml. Their sampled open fast-uri security-fix PRs were authored by dependabot[bot]. This is evidence of GitHub **security** updates, **not** evidence of configured routine Dependabot version updates or enabled Renovate. The actual GitHub App installation cannot be deduced from the tree alone.
- Engineering Foundation https://github.com/agent-teams-ai/engineering-foundation/blob/main/.github/dependabot.yml explicitly sets open-pull-requests-limit=0 for version updates while retaining configuration for the npm and Actions ecosystems. Shared organization Renovate policy existence does not override local consumer admission.
- Get Modular root https://github.com/agent-teams-ai/get-modular/blob/main/package.json declares Bun as packageManager, although it also has pnpm/YAML inputs; this does not qualify a new pnpm-only cross-repository projection for every future consumer.
- The earlier local working-tree six-repo/24-manifest sample and hash remain **unrehashed secondary evidence**, not an assertion about all fresh-main roots. Current live main and the exact manager version must be reread for a later implementation.

All observations above are snapshots. This document has not installed a bot, changed settings, generated production proposal PRs, executed consumer E2E or tested a new pg release.

## 4. Side-by-side tool comparison

| Option | pnpm catalogs/locks | Shared policy across repos | Exact desired pin synchronization | Native PR delivery | Operational/security cost | Fit |
| --- | --- | --- | --- | --- | --- | --- |
| **GitHub Dependabot (hosted)** | **Yes**, catalogs GA 2025-02-04; normal package manager work and security graph | Mostly each repo's dependabot.yml; common owner rules/templates are not an automatic shared-version preset | **Not an exact cross-repo pin authority**; normal version updater prefers eligible newer releases | Yes, built into GitHub | Low operational cost; relatively limited policy composition; 55-minute updater timeout and PR limits | Excellent for security; reasonable for simple per-repo versions |
| **Mend Renovate hosted GitHub App** | **Yes**: npm manager scans package.json and pnpm-workspace.yaml including default/named catalog types; native pnpm lock generation | **Yes**: portable Git-hosted local> shared presets, group/range/security/manager rules | **Conditional**: allowedVersions filters candidates and rangeStrategy pins representation; no documented guarantee of downgrade or exact fleet convergence | Yes, repo opted-in; Dependency Dashboard | Free hosted app; needs scoped installation and permission review; postUpgradeTasks restricted by default | **Preferred first full comparison/experiment** |
| **Renovate OSS CLI, self-hosted** | Same Renovate OSS engine when qualified | Yes, can add global inherited config/approved environment policies | Same semantic limit as hosted; self-hosting **does not magically solve exact-target propagation** | Yes, with GitHub integration credentials | Host/runtime/security patching, scheduling, container supply chain, rate/resource management; OSS AGPL-3.0-only | Only if hosted cannot meet a proven requirement |
| **Mend Renovate CE/EE self-hosted** | Renovate engine | Yes, hosting and scheduling refinements | Same desired-version distinction | Yes, stateful app/queue | CE/EE are **not simply the OSS CLI**; Mend docs describe them as separate closed-source EULA distributions; more operational and edition-specific support/cost constraints | Premature for first 2-repo pilot |
| **Syncpack** | Strong *intra-workspace* pnpm/Bun catalogs and version groups; can update catalog entries | No native cross-repo PR coordinator | Can pin and lint within **one** workspace, not one shared release applied to many repos | No built-in cross-repo PR fan-out | Adds an optional local development check/tool and its rules | Useful later per large monorepo; unnecessary globally if Foundation/native catalog suffice |
| **Updatecli** | General JSON/YAML targets and GitHub PRs; not a pnpm-specialist lock solver | Central declarative update rules can target Git files | Can deliberately write selected target values when explicitly scripted | Yes, through Git SCM target | More file/runner targeting and manager lock regeneration logic to govern | Narrow fallback for nonstandard non-package-manager declarations; avoid for ordinary npm/pnpm |
| **Custom Stack/catalog/updater** | Would need adapters and tests | Potentially yes | Can design exact target, but high ongoing correctness cost | Must integrate GitHub safely | Own release trust, parser, mutation, updater, support burden | **Not justified before a failed existing-tool experiment** |

These are **capability/maintenance judgments, not star/popularity ratings**. Having a GitHub App or a capable JSON DSL is not proof of correct end-to-end behavior in these exact repositories.

## 5. Dependabot: where it works and where it stops

**Strengths:** native GitHub Security Alerts and Security Update PRs, version-update scheduling via per-repo configuration, npm/pnpm workspace catalogs support, group controls, private registry credentials and pull-request controls. The official [2025-02-04 catalog GA announcement](https://github.blog/changelog/2025-02-04-dependabot-now-supports-pnpm-workspace-catalogs-ga/) specifically mentions scoped pnpm workspace updates and lock consistency. [GitHub's version updates guide](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-version-updates) confirms that *regular* updates require a dependabot.yml file; without it security updates may still run from settings.

**Gaps:** no equivalent native cross-repo shareable exact-version policy preset established by these documents; its own repo config has to specify manager/directory/schedule. A security PR for fast-uri does not prove ongoing YAML/Zod normal updates. Its [documented update failures](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-errors) include PR limits (default five version / ten security) and a **55-minute job timeout**, which matters for large workspace graphs. Dependabot update policy is not a replacement for the application's owner approval or Payments' packed peer-contract qualification.

**Recommended place:** leave GitHub security alerts and security update PRs enabled; do not forcibly replace a functioning security route during migration. Ordinary *version* update ownership can move to Renovate selectively **only after** per-repo settings/app overlap and existing gate behavior are checked. If Renovate cannot qualify the necessary manager versions, retain Dependabot version updates instead of implementing a new bot in a hurry.

**Potential conflict:** enabling both Dependabot routine versions and Renovate routine versions for YAML/pg can create competing branches. Assign only one regular version updater per selected field/repo. Preserve security proposals as a separately prioritized channel, and check whether Renovate itself also generates vulnerability-fix PRs; avoid duplicating them without disabling advisories or bypassing critical patches.

## 6. Renovate: capability, freedom and precise limits

### 6.1 Why it is the leading option

- The official [npm manager](https://docs.renovatebot.com/modules/manager/npm/) scans package.json, pnpm-workspace.yaml and .yarnrc.yml. Its dynamic catalog depType is pnpm.catalog.<name>, allowing package/type/file-specific rules; it delegates lockfile maintenance to the relevant package manager.
- [Shareable Git presets](https://docs.renovatebot.com/config-presets/) enable a central organization file, opt-in consumers and optionally Git-tagged releases. agent-teams-ai/.github already has exactly that shape. A later rule update edits *one* accepted central preset, not copies of its configuration throughout every participating repo.
- [Package rules](https://docs.renovatebot.com/configuration-options/) support package names, managers, dependency types, files, grouping, schedules, labels, dependency dashboard approval, version ranges and exclusion. These let library and app updates follow different policies and preserve local overrides.
- Existing hosted [Renovate GitHub App](https://github.com/apps/renovate) is **free for public and private repositories**; install on selected test repositories, not the entire organization, until proven. Mend's hosted [community free tier](https://docs.mend.io/renovate/latest/mend-renovate-cloud-resource-tiers) has resource tiers; pricing/hosting are not the source of runtime guarantees.

### 6.2 Two different policy modes

**Mode M — recommended baseline for continuous hygiene:** shared approved eligible version *range* and policy gates (for example only qualified patch/minor of an ordinary development family, coupled tool releases as one group, no auto-merge). Renovate proposes the newest acceptable upstream versions on each repo's own schedule/lock. **This does not guarantee identical pinned version everywhere on one day.** It is straightforward, scalable and avoids the need for a second data-only catalog.

**Mode E — a centrally reviewed exact desired version:** maintain one packageRule containing a strict allowed version **candidate**, for an explicitly selected family and actual manager/dependency kind, then let the updater propose changes. Verify on a *real run* that a repository on an older version receives that candidate (not a newer, excluded or preexisting one). Verify that a repo already beyond the target does **not silently remain permanently divergent or get an invented downgrade**. The official [allowedVersions description](https://docs.renovatebot.com/configuration-options/#packagerulesallowedversions) says it limits *how far to upgrade*, and warns not to combine allowedVersions with matchUpdateTypes in the *same* packageRule. rangeStrategy=pin changes specifier representation, not selected peer compatibility or catalog release semantics.

An illustration of the *shape of policy*, not a validated config nor permission to deploy it:

~~~json
{
  "extends": ["local>agent-teams-ai/.github:renovate-config"],
  "packageRules": [
    {
      "description": "Candidate YAML exact-install policy — P0 experiment only",
      "matchManagers": ["npm"],
      "matchPackageNames": ["yaml"],
      "allowedVersions": "2.9.0",
      "rangeStrategy": "pin",
      "automerge": false
    }
  ]
}
~~~

This example intentionally **does not** claim that this exact policy creates two repo PRs; it is a controlled hypothesis to validate. It must not be pasted over the real Docs Cohort, @types/node constraints or Toolchain native islands. Restrict to appropriate actual dependency kinds/files where the manager can prove them, and do not apply a global pg rule that accidentally changes Payments' optional peer.

**Policy provenance trade-off:** tracking local>... on the default branch means a centrally changed preset is consumed by the bot when it runs; this is intentionally a *moving policy*. A tag-pinned preset provides reviewable frozen versioning but then a new tag must be adopted by consumers. Renovate's [renovate-config manager](https://docs.renovatebot.com/modules/manager/renovate-config/) documents updates for some pinned GitHub presets but lists **local presets as unsupported** for that manager. Thus "immutable tag for every consumer + no effort to update each consumer" is not a guaranteed native turnkey combination. Prefer a central policy for *proposals*, with committed native manifest/lock as deterministic *build* authority, and review the actual resolved policy change before PR merge. Do not invent an offline proof that the bot never produced.

### 6.3 Important operational boundaries

**Security:** [postUpgradeTasks](https://docs.renovatebot.com/configuration-options/#postupgradetasks) are blocked by default; enabling them as a bridge from custom catalog JSON to native pnpm files requires elevated operator trust. Hosted app permissions include write to repository contents/PR/workflow surfaces; install only on approved test repos and review explicit code execution/registry access. Prefer native npm/pnpm manager updates without a custom command. Do not mix secrets or product credentials with untrusted PR generation.

**Node/pnpm tools:** actual consumers pin pnpm 11.18.0/11.25.0/11.28.2, with different strict peer/build/engine settings. Renovate *supports* pnpm generally, but it is not evidence it has executed these exact project-native qualification gates. Frozen installs, packed peers, PostgreSQL and financial tests remain independently mandatory.

**UI and scale:** the Dependency Dashboard is a useful **per-repo** review surface, not a documented fleet-wide health console. Existing org limits (5 concurrent PRs, 7 branches, 2 PRs/hour) moderate noise only where actual Renovate policy is adopted. A central per-repo proposal rule and an approved update pause can be more usable than implementing a new dashboard. A no-op update to an unrelated family must not trigger irrelevant PRs.

**Lifecycle:** use hosted community app as the first experiment. Self-hosted OSS CLI is a fallback only if permissions, deployment locality, custom scripts or a reproducible measured hosted limit make it necessary; it adds scheduling, secret management, upgrades, execution isolation and audit obligations. Do not substitute CE/EE and claim they are pure open-source builds.

## 7. Syncpack, Updatecli and other helper tools

**[Syncpack](https://syncpack.dev/version-groups/catalog/) is genuinely useful inside one monorepo.** It supports exact pinned/version-group policies, named catalog protocols, and native pnpm/Bun catalog manipulation, including filtering update operations to a named catalog. It is **not** a cross-repository update bot. For Foundation/Gateway/Payments, enabling its default auto-fix indiscriminately would be particularly risky because an existing optional peer and development declaration may intentionally differ or share a catalog key. Do not introduce a second linter/check that merely duplicates Foundation workspace-declaration capability without an observed gap.

**[Updatecli](https://github.com/updatecli/updatecli) is a useful declarative file-version update engine.** It has source/condition/target policies and GitHub PR support, including YAML/JSON targets, and is a much better starting point than writing generic Git/YAML mutation infrastructure if the future requirement involves nonstandard files. For normal pnpm dependencies, however, it does not itself replace pnpm's lock solver; a custom runner/permission and E2E story would still be needed. Keep it as a *measured* fallback, not as a required layer above Renovate.

**Generic security scanners or PR merge services** cannot decide a single exact approved vendor version or safely rewrite native manager graphs. Keep CodeQL/dependency review/security alerts and existing merge controls in their present owners; do not swap them for a new dependency-policy product.

## 8. Falsifiable disposable experiment (P0), no code or product PR changes

The following is a plan, **not an executed test result**. Do it only in approved throwaway repositories/branches and only with actual owner permission to install the selected GitHub App.

**Inputs to snapshot:**
- Two real catalog-YAML usage patterns: Payments pnpm 11.25.0 and Orchestrator pnpm 11.18.0 (yaml 2.9.0 in both workspace catalogs). Use copies/isolated fixtures, not edits to active product migrations.
- A separate **disposable** direct-literal manifest pattern based on Gateway's direct-runtime-pg style, rather than fabricating a production literal-YAML consumer.
- Payments' **read-only** optional peer+dev pg coupling with a native packed-consumer fixture. Do not pick a new pg release for the version-update experiment.

**Step-by-step acceptance:**
1. Verify whether the hosted Renovate App is actually installed/authorized for the exact throwaway repos. Enable only there; verify onboarding is inert and app permissions are understood.
2. Validate a minimal inherited preset and run Renovate in its actual host/test mode. Record engine version, target ref/manager/version, effective loaded rule and full PR diff. No arbitrary postUpgradeTasks and no lifecycle permission changes.
3. For a real approved *published* YAML change if one exists, or a **controlled tested pair of published older/newer versions** in disposable fixtures, change the central candidate rule once. Observe whether **two independent complete native workspace catalog and pnpm lock PR artifacts** appear. If no valid version delta is available, do not invent a release or claim success.
4. Verify a direct-literal fixture separately. Inspect the target vendor specifier, correct manager-generated lock, strict actual frozen install, existing comments/policy unchanged, exact pin from the central rule and output PR readability.
5. Change an **unrelated** family centrally and verify zero PRs for consumers that did not select it. Hold a third enrolled fixture and verify it remains on its earlier qualified pin without failing ordinary frozen CI.
6. Run negative tests: already-ahead candidate/downgrade, stale base PR, registry unavailable, invalid config, unknown manager setting, pnpm strict peer failure, and Payments' shared optional pg peer. The last must block a writer if the published packed peer would change. Verify existing security advisory PRs are neither disabled nor duplicated by both bots.
7. Record source SHA and actual resulting diff/CI outcomes. A dry-run extraction report alone is **not** a complete delivery E2E. A PR created does **not** qualify the final merged SHA.

**Decision criteria:**
- **Pass:** two complete reviewable native PRs, correct security/peer/manager constraints, no unrelated changes, no arbitrary scripts or new toolcode -> use hosted Renovate shared preset and stop. Treat exact-version adoption as a per-repo reviewed proposal.
- **Partial:** normal compatible upgrades and lockfiles work but exact desired target or immutable policy adoption remains uncertain -> prefer a clearly communicated review/manual exact-pin exception first; add a *small* independent drift check only if an actual ongoing error is demonstrated.
- **Fail:** engine cannot safely preserve owner policies or app trust boundary -> keep Dependabot per repo; test Updatecli for a narrowly specified file case or self-host OSS only for demonstrated deployment limitations; redesign separate catalog transport **only after** quantifying the gap.

No production rollout and no automatic merging are part of P0. No claims about an installed Renovate instance or real updater PRs are made until observed.

## 9. Future-proof operating model without a new framework

**Now:** central Renovate preset records desired *eligibility* and grouping. A repo explicitly extends the preset where Renovate is installed. The repo's native manifests and lock are its actual adopted runtime/development state. Its CI runs frozen install/strict peer, compile and only those real E2E/packed tests applicable to changed dependencies. Exceptions remain repository-owned and reviewed. Security alerts/PRs are a separate existing path.

**Later, only on evidence:** if a team repeatedly needs to freeze a **precise approved release** for multiple product contexts, distinguish central chosen pin vs active consumer pin, and immutable pinned-data adoption from a moving updater rule. A small read-only adopted-version report *might* be useful, but first compare existing Renovate dashboard/PRs and Foundation workspace rules. A standalone distribution artifact or generalized yaml projection must not be approved just because it is conceptually clean.

**At hundreds of repos:** controlled batches, existing PR limits, per-family scopes, no empty PRs, explicit held rollouts, source provenance and per-repo security/CI reduce noise more effectively than adding a global database. The first trigger to revisit architecture is **measured** loss of control: e.g. a tested exact-pin change cannot propagate to selected repos while preserving peer/contracts, or human operators cannot determine which opted-in consumers genuinely accepted it from existing PRs/status. A central dashboard is not part of the first dependency feature.

**At an emergency:** block new normal proposals, keep old immutable pins installable, prioritize actual security remediation, refuse an unsafe downgrade unless separately approved, issue independent recovery PRs and re-qualify each final head. Never rewrite immutable published data or mass-force-merge unrelated projects.

## 10. Recommendation and honest remaining gaps

**Preferred answer today: use the existing organization Renovate configuration and trial the free hosted GitHub App on selected throwaway consumers, retaining Dependabot security updates.** Make **zero modifications to Stack Toolchain code** until the updater's actual behavior disproves that this is sufficient.

**Unproven:** precise central pin propagation from one preset edit, exact manager-aware lock regeneration for each selected consumer, actual GitHub App installation, security-bot coexistence, and packed peer preservation. The comparative research establishes *documented product capabilities*, *current repo facts* and *testable uncertainties*, not a successful real updater E2E.

**Independence:** PR #458 is a research draft; its ReviewRouter runs have not produced complete independent review coverage. Neither this document nor assistant-authored critical lenses count as executed external multi-model review. Do not merge it as an adopted feature specification until an actual owner decision and independent design review.

## Primary sources

- GitHub Dependabot pnpm catalog GA: https://github.blog/changelog/2025-02-04-dependabot-now-supports-pnpm-workspace-catalogs-ga/
- GitHub version/security configuration: https://docs.github.com/en/code-security/concepts/supply-chain-security/about-the-dependabot-yml-file
- GitHub Dependabot limits/failure reasons: https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-errors
- Renovate official bot comparison: https://docs.renovatebot.com/bot-comparison/
- Renovate npm catalog/lock: https://docs.renovatebot.com/modules/manager/npm/
- Renovate shared presets and Git tags: https://docs.renovatebot.com/config-presets/
- Renovate allowedVersions and postUpgradeTasks: https://docs.renovatebot.com/configuration-options/
- Renovate config-preset update limitations: https://docs.renovatebot.com/modules/manager/renovate-config/
- GitHub App availability/permissions: https://github.com/apps/renovate and https://docs.renovatebot.com/security-and-permissions/
- Mend hosting tiers: https://docs.mend.io/renovate/latest/mend-renovate-cloud-resource-tiers
- Syncpack catalog support: https://syncpack.dev/version-groups/catalog/
- Updatecli policy engine: https://github.com/updatecli/updatecli
