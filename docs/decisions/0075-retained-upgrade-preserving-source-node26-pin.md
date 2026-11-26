---
id: ADR-0075
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0075: Retained Upgrade Preserving the Source Node 26 Pin

Decision owner: Product owner. The owner authorized current compatible tooling
and resolution of EF's source/runtime conflict while preserving Node 26. The
repository architecture coordinator records this bounded successor after two
independent architecture and recovery plan-review rounds on
`e2917d415ac8e270b83b2f9a6f678eb80c970ddf`.

Date: 2026-11-26. Implementation, native qualification, publication and consumer
adoption remain separate pending evidence.

## Scope and retained authority

Amend only ADR-0037's retained source/restoration observation requirements and
ADR-0070's explicit profile3/Cohort2 to profile4/Cohort3 route for a source whose
host pin already equals the deterministic target Node 26.11.1 image. Preserve
the historical ADR payloads and all other decisions. The frontmatter does not
supersede either complete decision because their remaining contracts stay in force.

Docs Protocol Agent Teams consumer-integration remains the sole application
owner. Repository Mutation remains the writer. Central retains cohort,
publication, lifecycle, qualification and enrollment authority; consumers retain
Host integration and complete quality gates. No package, migration manager,
public mode, schema family or receipt version is introduced by this decision.

The [reviewed delivery plan](../research/managed-node26-source-upgrade-2026-11-26.md)
owns implementation and qualification sequencing.

## Decision

1. Select a private bounded source reader only for the existing explicit
   retained prepare request: source generation2, target generation3,
   preparation enabled and a separately selected restoration-proof path.
   Compose the existing upgrade application with this reader. Ordinary legacy
   check/plan/apply, same-generation upgrade and target profile4 readers retain
   their existing behavior.
2. Observe actual controller Node24.21.0 independently from the consumer's host
   pin. Admit the existing qualified legacy Node24 source image or the exact
   preserved target image `26.11.1\n`. Retain stable regular-file observation,
   source HEAD/tree, clean physical root, repository identity, original
   package/lock graph, managed assets, historical projection and current
   protected authority checks. This grants no general unsupported-runtime flag.
3. Retain the original pin bytes and mode in the existing source Git/inventory
   proof. When source and target pin images are identical, omit
   `.node-version` from mutation operations. It remains a read-only guard;
   a no-op replacement must not create write ownership or compensation rights.
   The source, finalize, resume and restoration boundaries retain their existing
   leases, image/inventory comparisons and authority refresh.
4. Before admitting a current committed target for rollback, require its exact
   target pin and the preserved original mode where applicable. Bind that
   observation through the existing full current inventory and pre-CAS checks.
   A committed foreign pin or mode cannot be treated as an unrelated Host file
   merely because the forward operation did not write it.
5. For the preserved-host source, verify historical managed source/restored
   data through the retained controller's existing parsers, asset projections
   and planner. Require the exact selected source profile/repository/cohort and
   a current plan. Never import or execute the old consumer Foundation,
   TypeScript or API Extractor to obtain this observation. Keep the historical
   installed-CLI restoration path and its claims unchanged for its applicable
   legacy source. Name the new observation honestly; it is not successful
   execution of that old CLI or the old complete consumer gate.
6. Keep target installation and actual plan/apply/check on the real installed
   profile4 adapter under actual Node26.11.1 and pnpm11.20.0. Retain frozen
   offline source restoration, ignored lifecycle scripts and pnpm hooks, exact
   controller/kernel builds, claims, CAS, journals and receipt ownership.
   Missing offline material means incomplete/failed recovery even if inverse
   file publication succeeded. No online fallback or synthetic completion is
   allowed.
7. Refusal guarantees are phase-specific. Invalid initial admission refuses
   before staging; a failed selected runtime/manager preflight refuses before
   installation. Source or authority drift discovered during staging refuses
   before real-consumer publication. Drift after publication prevents completion
   and follows existing receipt-owned compensation/recovery rules. A later
   refusal cannot erase effects that already occurred.
8. Cold recovery means a new process with selected exact builds and runtimes,
   using deliberately prepared and identified offline caches. Lost receipt
   companions retain the existing honest already-satisfied observation; they do
   not recreate write ownership. Committed rollback after Host integration
   follows ADR-0070's existing owner reversal of overlapping Host fields on the
   unmerged rollback branch before fresh current selection. Unrelated Host files
   remain preserved.

## Qualification and delivery

New and affected positive recovery cases must really execute under the exact
Node24.21.0 route; an early wrong-runtime refusal under default Node26 is separate
evidence. Retain strict TypeScript7.0.2 coverage and complete test inventories.

Qualification must cover exact preserved-pin preparation, ordinary-route
refusal, actual target activation, receipt-owned compensation, fresh-process
forward/inverse resume, lost receipt companion, committed byte/mode pin drift,
source/authority/build drift and post-Host-integration rollback. Reuse the
deny-only compiler-load guard with alias/realpath checks, child coverage and
sticky failure. Test the guard with synthetic negative modules, never by
initializing an obsolete compiler.

Focused fixtures and TEST activation ports establish only their declared mutation
and recovery scope. Packed/hermetic-registry qualification and subsequently real
published-package forward, cold recovery and source restoration are required
separate evidence. Actual enrolled EF full checks and merged-main E1 observation
remain delivery gates.

Use the ordinary Changesets planner and publisher for a fresh coherent current
cohort, with explicit supported recovery intent where older published coordinates
lack an admitted successful mint-run observation. Preserve Central's existing
provenance and same-run reconciliation rules. Qualify only actual new published
versions/SRIs and enroll EF explicitly; this decision does not append a cohort,
admit a consumer or authorize rollout to other repositories.

The existing accepted-decision promoter records this bounded authority. It does
not edit historical ADRs or release-owned public API/schema baselines.

