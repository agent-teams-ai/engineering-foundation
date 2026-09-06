# @agent-teams/engineering-foundation

## 1.1.0

### Minor Changes

- [`11461b0`](https://github.com/agent-teams-ai/engineering-foundation/commit/11461b0b3e308c548a84c0159cbe1a9a4f235c43) Thanks [@777genius](https://github.com/777genius)! - Compare concrete wildcard exports and exported JSON Schema bytes through the
  existing public API release policy. Prepare initial records from retained
  archives explicitly; ordinary checks never create a missing artifact baseline.
  Promotion validates typed and artifact surfaces before writing and rejects
  same-version mutation and stale artifact evidence.

- [`b39e1e7`](https://github.com/agent-teams-ai/engineering-foundation/commit/b39e1e7f258df2acc5261191ce7916d8079f049b) Thanks [@777genius](https://github.com/777genius)! - Add the testing-only scaffolding/qualification entrypoint with runScaffoldCrashQualification. It awaits eleven typed scaffold checkpoints using the production authority, journal and transaction dependencies, enabling disposable consumer crash tests to retain public recovery and exact byte/drift assertions. Production scaffolding APIs and persisted formats are unchanged.

### Patch Changes

- [`a9f2ab1`](https://github.com/agent-teams-ai/engineering-foundation/commit/a9f2ab1c268e64d0b217e4030bbbbffcaf371562) Thanks [@777genius](https://github.com/777genius)! - Read process environment and time through explicit Node boundaries. Use one
  observed instant for both restoration authority bindings, reject invalid clock
  observations, and retain the offline Corepack network restriction.

- [`47ac684`](https://github.com/agent-teams-ai/engineering-foundation/commit/47ac684f78cbe65d5dfa09633d48558950a9eb35) Thanks [@777genius](https://github.com/777genius)! - Preserve document envelope v3/v4 and known-file envelope v5 as untrusted manual evidence in split Foundation. Matching claimed version and build strings never grant their local recovery leases; diagnostics direct operators to the claimed owner's exact external reader. Keep current wire6 known-file owner/kernel checks and scaffolding recovery, and bind the frozen historical Plan dependency used by envelope v2. This patch requires the coordinated owner schema cutover before publication.

- Updated dependencies [[`a9dc628`](https://github.com/agent-teams-ai/engineering-foundation/commit/a9dc6286af74a02e4929273acf4d1a680f6f4c9a), [`ec09d48`](https://github.com/agent-teams-ai/engineering-foundation/commit/ec09d482515efa2b4d25cd04b96853f4f031ce84), [`5399afc`](https://github.com/agent-teams-ai/engineering-foundation/commit/5399afcb232210986bf8bd2c31683fc917eec7a4)]:
  - @agent-teams/document-authoring@0.3.0
  - @agent-teams/repository-mutation@0.2.0

## 1.0.1

### Patch Changes

- [#251](https://github.com/agent-teams-ai/engineering-foundation/pull/251) [`24443cf`](https://github.com/agent-teams-ai/engineering-foundation/commit/24443cff28ecc9b2fb993541dbbbdcdec353b12e) Thanks [@777genius](https://github.com/777genius)! - Inspect governed source inside nested coverage and dist directories and explicitly selected generated-name roots while preserving ordinary package-root generated outputs and explicit source-dependency scope.

  Include explicit boundary source roots beneath broader governed roots when traversing coverage and dist routes, including source-file roots and diagnostic fallback discovery. Keep generated siblings excluded and retain v1 governed-only and v2 selected-package coverage.

- [#257](https://github.com/agent-teams-ai/engineering-foundation/pull/257) [`c99caa1`](https://github.com/agent-teams-ai/engineering-foundation/commit/c99caa1a785cfc7c876c79bf6934e228555e6afd) Thanks [@777genius](https://github.com/777genius)! - Publish a coordinated patch wave to obtain a new release provenance origin for managed Cohort qualification, preserving existing package behavior and exact internal dependency alignment.

- [#253](https://github.com/agent-teams-ai/engineering-foundation/pull/253) [`2196ccb`](https://github.com/agent-teams-ai/engineering-foundation/commit/2196ccb00e6161c9be94b22dfc09dee608e53942) Thanks [@777genius](https://github.com/777genius)! - Keep npm alias import slots, target identities, catalog provenance and effective versions distinct when checking dependency declarations and source imports. Apply development-only and reserved-scope restrictions to alias targets without relaxing exact-version or declaration requirements.

  Preserve Node self-reference precedence and valid registry range whitespace. Malformed aliases cannot grant dependency authority. Existing `allow.packages` permissions continue to name import slots.

- Updated dependencies [[`c99caa1`](https://github.com/agent-teams-ai/engineering-foundation/commit/c99caa1a785cfc7c876c79bf6934e228555e6afd), [`0c61b76`](https://github.com/agent-teams-ai/engineering-foundation/commit/0c61b7639029494e44582212f0d3e586887a4eac)]:
  - @agent-teams/repository-mutation@0.1.1
  - @agent-teams/document-authoring@0.2.0

## 1.0.0

### Major Changes

- [#232](https://github.com/agent-teams-ai/engineering-foundation/pull/232) [`e486355`](https://github.com/agent-teams-ai/engineering-foundation/commit/e4863550a0e44769987a98a9f98fa6ccc9b1d014) Thanks [@777genius](https://github.com/777genius)! - Extract portable document authoring into its own package, remove the obsolete
  Engineering Foundation authoring exports and CLI, and rewire Docs Protocol to
  the new-only dependency graph without a compatibility facade.

- [#224](https://github.com/agent-teams-ai/engineering-foundation/pull/224) [`4e22962`](https://github.com/agent-teams-ai/engineering-foundation/commit/4e229623ff555b655e7df24f9d1502ec5b968911) Thanks [@777genius](https://github.com/777genius)! - Extract the zero-monorepo-dependency Repository Mutation leaf, cut generic
  callers over to its new-only API, and remove the obsolete Foundation mutation
  facade.

### Minor Changes

- [#224](https://github.com/agent-teams-ai/engineering-foundation/pull/224) [`4e22962`](https://github.com/agent-teams-ai/engineering-foundation/commit/4e229623ff555b655e7df24f9d1502ec5b968911) Thanks [@777genius](https://github.com/777genius)! - Add source-dependencies v2 with an explicit `packageRoots` contract, closed
  package/source/boundary ownership, manifest-and-architecture workspace edges,
  public-export enforcement, and deterministic runtime/type-only cycle checks.
  Activate v2 in Foundation dogfood while keeping the released v1 schema loadable
  for external consumers.

### Patch Changes

- [#224](https://github.com/agent-teams-ai/engineering-foundation/pull/224) [`4e22962`](https://github.com/agent-teams-ai/engineering-foundation/commit/4e229623ff555b655e7df24f9d1502ec5b968911) Thanks [@777genius](https://github.com/777genius)! - Add the durable post-publication checkpoint to the closed document-authoring qualification API.

- [#227](https://github.com/agent-teams-ai/engineering-foundation/pull/227) [`b0d116e`](https://github.com/agent-teams-ai/engineering-foundation/commit/b0d116ecaeb6e744b3c4ce91d7325502887f6399) Thanks [@777genius](https://github.com/777genius)! - Harden Windows process containment confirmation and emit bounded cleanup
  diagnostics without exposing child-process output. Compile the native helper
  from trusted source text so deep installed package paths never enter CodeDom.

- [#230](https://github.com/agent-teams-ai/engineering-foundation/pull/230) [`8c6a252`](https://github.com/agent-teams-ai/engineering-foundation/commit/8c6a252fe36d868bd3757a370b60775ecdafd185) Thanks [@777genius](https://github.com/777genius)! - Compose the document-authoring and scaffolding journal stores over one shared
  journal slot store in Repository Mutation's Node-only mechanism surface. Both owners
  keep their released on-disk names, byte formats, fault phases, crash residue,
  and error wording; only the duplicated candidate, quarantine, retirement, and
  reconciliation mechanics now live in one implementation. The retired
  pretty-printed scaffold journal writer is removed; reading the historical format
  is unchanged.

  Two deliberate hardenings come with the shared store. A journal file that
  disappears during a proof now reports the owner's "changed" diagnostic instead
  of a raw `ENOENT`. Document authoring now re-proves its candidate immediately
  before hard-linking it into the canonical slot and refuses to report a removal
  as complete when the canonical slot was recreated concurrently, matching what
  scaffolding already guaranteed. Both owners now validate the journal before
  probing slot occupancy, so an invalid journal aimed at an occupied slot reports
  the contract error first.

- Updated dependencies [[`14ff06f`](https://github.com/agent-teams-ai/engineering-foundation/commit/14ff06fd984c33106b5322d672bc1e0af2bbc9f8), [`e486355`](https://github.com/agent-teams-ai/engineering-foundation/commit/e4863550a0e44769987a98a9f98fa6ccc9b1d014), [`4e22962`](https://github.com/agent-teams-ai/engineering-foundation/commit/4e229623ff555b655e7df24f9d1502ec5b968911), [`8c6a252`](https://github.com/agent-teams-ai/engineering-foundation/commit/8c6a252fe36d868bd3757a370b60775ecdafd185)]:
  - @agent-teams/document-authoring@0.1.0
  - @agent-teams/repository-mutation@0.1.0

## 0.21.0

### Minor Changes

- [#217](https://github.com/agent-teams-ai/engineering-foundation/pull/217) [`24c7b35`](https://github.com/agent-teams-ai/engineering-foundation/commit/24c7b355123cab25a8d143f29e48adb33874fbdf) Thanks [@777genius](https://github.com/777genius)! - Add the immutable four-field v1 scoped scaffolding recovery overload while
  preserving the existing one-argument API, CLI, journal protocol, and portable
  recovery. Scope paths follow the published v1 schema without host-specific
  narrowing.

### Patch Changes

- [#217](https://github.com/agent-teams-ai/engineering-foundation/pull/217) [`24c7b35`](https://github.com/agent-teams-ai/engineering-foundation/commit/24c7b355123cab25a8d143f29e48adb33874fbdf) Thanks [@777genius](https://github.com/777genius)! - Emit one canonical JSON error envelope when SIGINT or SIGTERM cancels quality-gate
  configuration or catalog loading, with exit codes 130 and 143 respectively.
  Retain an already observed successful task as passed with exit code 0 while the
  aggregate run is cancelled, and keep task or containment failures authoritative
  over cancellation.

## 0.20.0

### Minor Changes

- [#203](https://github.com/agent-teams-ai/engineering-foundation/pull/203) [`b6151f7`](https://github.com/agent-teams-ai/engineering-foundation/commit/b6151f7f7f8118817318ba8c060659e84c7e7a7f) Thanks [@777genius](https://github.com/777genius)! - Add the data-only Docs Protocol qualification v2 suite, complete authoring previews, fixed-index readiness, and reusable local owner sets while preserving v1 migration routes.

### Patch Changes

- [#201](https://github.com/agent-teams-ai/engineering-foundation/pull/201) [`58a3766`](https://github.com/agent-teams-ai/engineering-foundation/commit/58a37663e84f1225ca4866b71c61ae88a783c8a6) Thanks [@777genius](https://github.com/777genius)! - Fix the repository agent workflow changed-scope script to invoke the built Foundation CLI reliably from a source checkout.

## 0.19.0

### Minor Changes

- [#192](https://github.com/agent-teams-ai/engineering-foundation/pull/192) [`393c51e`](https://github.com/agent-teams-ai/engineering-foundation/commit/393c51ebaa823d9b107fae287416aa821ac53548) Thanks [@777genius](https://github.com/777genius)! - Guarantee fail-safe operation-lock release and preserve actionable known-file
  recovery status. Keep Docs Protocol JSON output machine-readable for bounded
  argument failures and enforce its internal source-layer boundaries.

### Patch Changes

- [#195](https://github.com/agent-teams-ai/engineering-foundation/pull/195) [`fa9bbf9`](https://github.com/agent-teams-ai/engineering-foundation/commit/fa9bbf93afb43fbf1a8d72cbefc90f5b2878f7b8) Thanks [@777genius](https://github.com/777genius)! - Preserve the primary known-file transaction or recovery failure when operation-lock
  release also fails, while retaining recovery evidence until lock release succeeds.

## 0.18.0

### Minor Changes

- [#188](https://github.com/agent-teams-ai/engineering-foundation/pull/188) [`b4b5f14`](https://github.com/agent-teams-ai/engineering-foundation/commit/b4b5f1466238e90c4e55db6a4faadd8ffb4c53ae) Thanks [@777genius](https://github.com/777genius)! - Add bounded unexpected-failure diagnostics without changing the v1 check-report contract, expose repository-mutation qualification seams through a dedicated subpath, and deprecate the retained concrete and low-level aliases.

### Patch Changes

- [#186](https://github.com/agent-teams-ai/engineering-foundation/pull/186) [`8469679`](https://github.com/agent-teams-ai/engineering-foundation/commit/8469679d25a60974f7059425283b0d065e4c7c98) Thanks [@777genius](https://github.com/777genius)! - Classify known-file recovery transitions at the application boundary without changing recovery behavior or wire contracts.

- [#190](https://github.com/agent-teams-ai/engineering-foundation/pull/190) [`bc50b70`](https://github.com/agent-teams-ai/engineering-foundation/commit/bc50b704aa4f3832d612b4a1c94738335be702c9) Thanks [@777genius](https://github.com/777genius)! - Decompose known-file apply observation, durable transitions, filesystem effects, and operation orchestration without changing its wire or fault contracts.

- [#189](https://github.com/agent-teams-ai/engineering-foundation/pull/189) [`d41f51c`](https://github.com/agent-teams-ai/engineering-foundation/commit/d41f51c641a6318b69ac33f29154baf7640c9bf0) Thanks [@777genius](https://github.com/777genius)! - Require ready-for-review coverage in explicitly filtered pull-request Dependency Review workflows.

## 0.17.0

### Minor Changes

- [#171](https://github.com/agent-teams-ai/engineering-foundation/pull/171) [`21184bf`](https://github.com/agent-teams-ai/engineering-foundation/commit/21184bfcd9b19e2a8bc23ab2d0c68d987c2e92cd) Thanks [@777genius](https://github.com/777genius)! - Add the opt-in `quality.gate-runner` capability and explicit `gate run` CLI for deterministic, bounded package-script DAG profiles with timeout, cancellation, and versioned result evidence.

- [#140](https://github.com/agent-teams-ai/engineering-foundation/pull/140) [`b228651`](https://github.com/agent-teams-ai/engineering-foundation/commit/b2286510150293e7355a7abe284432a9e3d3671d) Thanks [@777genius](https://github.com/777genius)! - Add recoverable exact-preimage known-file transactions to Foundation and a
  write-free, cohort-bound Docs Protocol consumer integration lifecycle with
  deterministic check, plan, apply, recovery, schemas, and offline sandbox E2E.

- [#113](https://github.com/agent-teams-ai/engineering-foundation/pull/113) [`9b1544b`](https://github.com/agent-teams-ai/engineering-foundation/commit/9b1544bcefed647fbe7d4bee5a05d12cd526d6d6) Thanks [@777genius](https://github.com/777genius)! - Add the versioned Foundation directory-materialization kernel used by the
  staged unified documentation protocol. Provide deterministic planning,
  publication, evidence, and recovery backed by consumer-owned data-only profiles
  and portable transactional filesystem guarantees.

### Patch Changes

- [#173](https://github.com/agent-teams-ai/engineering-foundation/pull/173) [`207a357`](https://github.com/agent-teams-ai/engineering-foundation/commit/207a3570370eeb23dd8c4ea39d8ed836a00e4916) Thanks [@777genius](https://github.com/777genius)! - Derive the private capability and rule registries from one typed module descriptor list.

- [#166](https://github.com/agent-teams-ai/engineering-foundation/pull/166) [`da4a859`](https://github.com/agent-teams-ai/engineering-foundation/commit/da4a859eb1bd86e9a51373751c5329d45a120fc5) Thanks [@777genius](https://github.com/777genius)! - Publish a fresh Foundation prerelease so the pending Docs Protocol rc11 and its
  exact dependency are produced by one protected-main provenance commit.

- [#156](https://github.com/agent-teams-ai/engineering-foundation/pull/156) [`89cd8d2`](https://github.com/agent-teams-ai/engineering-foundation/commit/89cd8d2226b0214b37eb2258b4dc078a20715fd4) Thanks [@777genius](https://github.com/777genius)! - Bundle the qualified rc7 Cohort's immutable managed assets so consumers can prove
  and execute upgrades to successor Cohorts without weakening conflict detection.

- [#160](https://github.com/agent-teams-ai/engineering-foundation/pull/160) [`c5f3718`](https://github.com/agent-teams-ai/engineering-foundation/commit/c5f3718f1c4829de00bacaf5f37b0ead133abdd2) Thanks [@777genius](https://github.com/777genius)! - Bundle the qualified rc9 Cohort as an immutable upgrade source and accept
  consumer-specific registry-bound transitive resolutions while preserving exact
  managed package versions, SRI, physical resolution, and dependency edges.

- [#146](https://github.com/agent-teams-ai/engineering-foundation/pull/146) [`06c6586`](https://github.com/agent-teams-ai/engineering-foundation/commit/06c6586b2426cfeb605be20d9089c70fb246a7cf) Thanks [@777genius](https://github.com/777genius)! - Refresh the Foundation release identity so the corrected Docs Protocol can
  publish as one provenance-owned ordered pair.

- [#153](https://github.com/agent-teams-ai/engineering-foundation/pull/153) [`ed0a09b`](https://github.com/agent-teams-ai/engineering-foundation/commit/ed0a09b2b2c807e8362c0afe5a84d1d2bff2e982) Thanks [@777genius](https://github.com/777genius)! - Publish a fresh Foundation prerelease from the same source commit as the pending Docs Protocol prerelease so the exact package pair preserves its ordered provenance invariant.

- [#149](https://github.com/agent-teams-ai/engineering-foundation/pull/149) [`9a68e79`](https://github.com/agent-teams-ai/engineering-foundation/commit/9a68e7975093e426efe1b970f273a86ad9f55f9d) Thanks [@777genius](https://github.com/777genius)! - Bundle the withdrawn rc1 Cohort's immutable documentation assets so corrected
  successor Cohorts can prove and execute their declared rollback edge.

- [#168](https://github.com/agent-teams-ai/engineering-foundation/pull/168) [`36d9053`](https://github.com/agent-teams-ai/engineering-foundation/commit/36d905362955255c3faed930b11a1e6f05a87ee9) Thanks [@777genius](https://github.com/777genius)! - Add a read-only repository agent workflow command that explains effective `AGENTS.md` precedence, shadowing, byte budgets, and digests for a selected file.

- [#179](https://github.com/agent-teams-ai/engineering-foundation/pull/179) [`dd3a17c`](https://github.com/agent-teams-ai/engineering-foundation/commit/dd3a17ca67a397d90340243e0566f3db94c34458) Thanks [@777genius](https://github.com/777genius)! - Mark the legacy Foundation docs CLI as a frozen compatibility surface, emit a
  stable human-mode deprecation diagnostic, and direct current usage to Docs
  Protocol without changing legacy JSON behavior.

- [#172](https://github.com/agent-teams-ai/engineering-foundation/pull/172) [`c099de7`](https://github.com/agent-teams-ai/engineering-foundation/commit/c099de7195c4c926bec0999a3936114435861b07) Thanks [@777genius](https://github.com/777genius)! - Report deterministic committed, staged, unstaged, and untracked changed-scope evidence with immutable Git identities, a stable digest, strict UTF-8 paths, and hardened read-only Git discovery.

- [#178](https://github.com/agent-teams-ai/engineering-foundation/pull/178) [`5724da1`](https://github.com/agent-teams-ai/engineering-foundation/commit/5724da1399182efbc424292101e599b1125cbb30) Thanks [@777genius](https://github.com/777genius)! - Harden effective-instruction target validation, exact CLI arity, byte-budget reads, stable metadata observation, Codex-compatible text admission, and deterministic digest evidence.

- [#141](https://github.com/agent-teams-ai/engineering-foundation/pull/141) [`055f86e`](https://github.com/agent-teams-ai/engineering-foundation/commit/055f86eab2413cca4f0ff269bdaff3d979dd0f70) Thanks [@777genius](https://github.com/777genius)! - Honor the exact Changesets initial version when promoting public API baselines within one numbered prerelease train.

- [#158](https://github.com/agent-teams-ai/engineering-foundation/pull/158) [`ca276ca`](https://github.com/agent-teams-ai/engineering-foundation/commit/ca276ca5a502ceba013106bf2270bc87b9b407a5) Thanks [@777genius](https://github.com/777genius)! - Keep ordered trusted publishing open for bounded three-minute npm provenance and idempotent GitHub reconciliation windows.

## 0.17.0-rc.8

### Patch Changes

- [#166](https://github.com/agent-teams-ai/engineering-foundation/pull/166) [`da4a859`](https://github.com/agent-teams-ai/engineering-foundation/commit/da4a859eb1bd86e9a51373751c5329d45a120fc5) Thanks [@777genius](https://github.com/777genius)! - Publish a fresh Foundation prerelease so the pending Docs Protocol rc11 and its
  exact dependency are produced by one protected-main provenance commit.

## 0.17.0-rc.7

### Patch Changes

- [#160](https://github.com/agent-teams-ai/engineering-foundation/pull/160) [`c5f3718`](https://github.com/agent-teams-ai/engineering-foundation/commit/c5f3718f1c4829de00bacaf5f37b0ead133abdd2) Thanks [@777genius](https://github.com/777genius)! - Bundle the qualified rc9 Cohort as an immutable upgrade source and accept
  consumer-specific registry-bound transitive resolutions while preserving exact
  managed package versions, SRI, physical resolution, and dependency edges.

## 0.17.0-rc.6

### Patch Changes

- [#158](https://github.com/agent-teams-ai/engineering-foundation/pull/158) [`ca276ca`](https://github.com/agent-teams-ai/engineering-foundation/commit/ca276ca5a502ceba013106bf2270bc87b9b407a5) Thanks [@777genius](https://github.com/777genius)! - Keep ordered trusted publishing open for bounded three-minute npm provenance and idempotent GitHub reconciliation windows.

## 0.17.0-rc.5

### Patch Changes

- [#156](https://github.com/agent-teams-ai/engineering-foundation/pull/156) [`89cd8d2`](https://github.com/agent-teams-ai/engineering-foundation/commit/89cd8d2226b0214b37eb2258b4dc078a20715fd4) Thanks [@777genius](https://github.com/777genius)! - Bundle the qualified rc7 Cohort's immutable managed assets so consumers can prove
  and execute upgrades to successor Cohorts without weakening conflict detection.

## 0.17.0-rc.4

### Patch Changes

- [#153](https://github.com/agent-teams-ai/engineering-foundation/pull/153) [`ed0a09b`](https://github.com/agent-teams-ai/engineering-foundation/commit/ed0a09b2b2c807e8362c0afe5a84d1d2bff2e982) Thanks [@777genius](https://github.com/777genius)! - Publish a fresh Foundation prerelease from the same source commit as the pending Docs Protocol prerelease so the exact package pair preserves its ordered provenance invariant.

## 0.17.0-rc.3

### Patch Changes

- [#149](https://github.com/agent-teams-ai/engineering-foundation/pull/149) [`9a68e79`](https://github.com/agent-teams-ai/engineering-foundation/commit/9a68e7975093e426efe1b970f273a86ad9f55f9d) Thanks [@777genius](https://github.com/777genius)! - Bundle the withdrawn rc1 Cohort's immutable documentation assets so corrected
  successor Cohorts can prove and execute their declared rollback edge.

## 0.17.0-rc.2

### Patch Changes

- [#146](https://github.com/agent-teams-ai/engineering-foundation/pull/146) [`06c6586`](https://github.com/agent-teams-ai/engineering-foundation/commit/06c6586b2426cfeb605be20d9089c70fb246a7cf) Thanks [@777genius](https://github.com/777genius)! - Refresh the Foundation release identity so the corrected Docs Protocol can
  publish as one provenance-owned ordered pair.

## 0.17.0-rc.1

### Minor Changes

- [#140](https://github.com/agent-teams-ai/engineering-foundation/pull/140) [`b228651`](https://github.com/agent-teams-ai/engineering-foundation/commit/b2286510150293e7355a7abe284432a9e3d3671d) Thanks [@777genius](https://github.com/777genius)! - Add recoverable exact-preimage known-file transactions to Foundation and a
  write-free, cohort-bound Docs Protocol consumer integration lifecycle with
  deterministic check, plan, apply, recovery, schemas, and offline sandbox E2E.

### Patch Changes

- [#141](https://github.com/agent-teams-ai/engineering-foundation/pull/141) [`055f86e`](https://github.com/agent-teams-ai/engineering-foundation/commit/055f86eab2413cca4f0ff269bdaff3d979dd0f70) Thanks [@777genius](https://github.com/777genius)! - Honor the exact Changesets initial version when promoting public API baselines within one numbered prerelease train.

## 0.17.0-rc.0

### Minor Changes

- [#113](https://github.com/agent-teams-ai/engineering-foundation/pull/113) [`9b1544b`](https://github.com/agent-teams-ai/engineering-foundation/commit/9b1544bcefed647fbe7d4bee5a05d12cd526d6d6) Thanks [@777genius](https://github.com/777genius)! - Add the versioned Foundation directory-materialization kernel used by the
  staged unified documentation protocol. Provide deterministic planning,
  publication, evidence, and recovery backed by consumer-owned data-only profiles
  and portable transactional filesystem guarantees.

## 0.16.1

### Patch Changes

- [#115](https://github.com/agent-teams-ai/engineering-foundation/pull/115) [`dbbcf71`](https://github.com/agent-teams-ai/engineering-foundation/commit/dbbcf7126d3438eb11991264b97265f0ccde0110) Thanks [@777genius](https://github.com/777genius)! - Allow repository security policy to declare exact reviewed workflow paths that use `pull_request_target`, while rejecting undeclared and stale privileged-trigger routes.

- [#111](https://github.com/agent-teams-ai/engineering-foundation/pull/111) [`6138b28`](https://github.com/agent-teams-ai/engineering-foundation/commit/6138b286738a0c60d21d49656e5a91a271fce07c) Thanks [@777genius](https://github.com/777genius)! - Fail fast when capability or diagnostic rule registries contain duplicate IDs,
  and keep configured capabilities aligned with the runtime registry.

## 0.16.1-rc.0

### Patch Changes

- [#115](https://github.com/agent-teams-ai/engineering-foundation/pull/115) [`dbbcf71`](https://github.com/agent-teams-ai/engineering-foundation/commit/dbbcf7126d3438eb11991264b97265f0ccde0110) Thanks [@777genius](https://github.com/777genius)! - Allow repository security policy to declare exact reviewed workflow paths that use `pull_request_target`, while rejecting undeclared and stale privileged-trigger routes.

- [#111](https://github.com/agent-teams-ai/engineering-foundation/pull/111) [`6138b28`](https://github.com/agent-teams-ai/engineering-foundation/commit/6138b286738a0c60d21d49656e5a91a271fce07c) Thanks [@777genius](https://github.com/777genius)! - Fail fast when capability or diagnostic rule registries contain duplicate IDs,
  and keep configured capabilities aligned with the runtime registry.

## 0.16.0

### Minor Changes

- [#99](https://github.com/agent-teams-ai/engineering-foundation/pull/99) [`a030267`](https://github.com/agent-teams-ai/engineering-foundation/commit/a0302673c0ba5d2dd2e38f9e32942f0aea80772f) Thanks [@777genius](https://github.com/777genius)! - Add the durable document-writer release candidate with exact Plan application,
  transaction recovery, receipt evidence, and the versioned envelope v3 schema.
  Expose versioned document transaction inspection for exact `docs-recover`
  routing while preserving the legacy local-mode status contract.
  Correct selected-capability coverage semantics and add a versioned JSON failure
  envelope for non-document CLI commands.

## 0.16.0-rc.0

### Minor Changes

- [#99](https://github.com/agent-teams-ai/engineering-foundation/pull/99) [`a030267`](https://github.com/agent-teams-ai/engineering-foundation/commit/a0302673c0ba5d2dd2e38f9e32942f0aea80772f) Thanks [@777genius](https://github.com/777genius)! - Add the durable document-writer release candidate with exact Plan application,
  transaction recovery, receipt evidence, and the versioned envelope v3 schema.
  Expose versioned document transaction inspection for exact `docs-recover`
  routing while preserving the legacy local-mode status contract.
  Correct selected-capability coverage semantics and add a versioned JSON failure
  envelope for non-document CLI commands.

## 0.15.0

### Minor Changes

- [#97](https://github.com/agent-teams-ai/engineering-foundation/pull/97) [`11d1fcb`](https://github.com/agent-teams-ai/engineering-foundation/commit/11d1fcb536e818f0444b8b317f043aba7aa1b928) Thanks [@777genius](https://github.com/777genius)! - Add deterministic read-only document planning from a governed Intent and consumer authorities.

### Patch Changes

- [#96](https://github.com/agent-teams-ai/engineering-foundation/pull/96) [`7d82fd6`](https://github.com/agent-teams-ai/engineering-foundation/commit/7d82fd672a232e4897add738596c5bf40ff2d97f) Thanks [@777genius](https://github.com/777genius)! - Harden published compatibility qualification with one fail-closed npm install timeout retry shared across the complete E2E.

## 0.14.0

### Minor Changes

- [#94](https://github.com/agent-teams-ai/engineering-foundation/pull/94) [`3f0d16e`](https://github.com/agent-teams-ai/engineering-foundation/commit/3f0d16e1172a387e0ed00606988b4e3fd89a669c) Thanks [@777genius](https://github.com/777genius)! - Correct the pre-adoption document-authoring v1 contracts with explicit path inputs, closed identity and placement semantics, domain-separated digests, canonical Markdown rendering, and shared portable path conformance vectors.

## 0.13.1

### Patch Changes

- [#93](https://github.com/agent-teams-ai/engineering-foundation/pull/93) [`e68e0d4`](https://github.com/agent-teams-ai/engineering-foundation/commit/e68e0d4dcde95deec2d0d851274c8cfdbec087ed) Thanks [@777genius](https://github.com/777genius)! - Make concurrent exact repository publications converge when hard-link cleanup briefly changes inode metadata.

- [#91](https://github.com/agent-teams-ai/engineering-foundation/pull/91) [`1c4843d`](https://github.com/agent-teams-ai/engineering-foundation/commit/1c4843d1cc75bf6b9578d94a3e01748d1791e3a1) Thanks [@777genius](https://github.com/777genius)! - Extract private repository-mutation primitives for shared transaction and filesystem safety without changing the public package API.

## 0.13.0

### Minor Changes

- [#89](https://github.com/agent-teams-ai/engineering-foundation/pull/89) [`70e6a2b`](https://github.com/agent-teams-ai/engineering-foundation/commit/70e6a2b889602878bd98959ea64bb9854c020085) Thanks [@777genius](https://github.com/777genius)! - Add the internal Foundation transaction coordinator, semantic legacy and v2
  envelope inspection, preserved package-artifact identity diagnostics, a
  crash-safe owner-token operation lock, local-mode crash-state admission, and
  persistent downgrade barriers shared by scaffolding and local package switching.

## 0.12.0

### Minor Changes

- [#85](https://github.com/agent-teams-ai/engineering-foundation/pull/85) [`57d1378`](https://github.com/agent-teams-ai/engineering-foundation/commit/57d137871e325649a8ae246b760e9298f7b8cddc) Thanks [@777genius](https://github.com/777genius)! - Add the deterministic read-only document catalog API and strict authority adapters.

- [#84](https://github.com/agent-teams-ai/engineering-foundation/pull/84) [`03f4201`](https://github.com/agent-teams-ai/engineering-foundation/commit/03f4201f46f45bedf1240a8018b919b50fc6859b) Thanks [@777genius](https://github.com/777genius)! - Publish the closed document authoring protocol schemas and transaction envelope
  contracts without enabling a runtime writer.

- [#86](https://github.com/agent-teams-ai/engineering-foundation/pull/86) [`4123de0`](https://github.com/agent-teams-ai/engineering-foundation/commit/4123de02d0e1e5fc808adf2c284530607dcd0276) Thanks [@777genius](https://github.com/777genius)! - Add deterministic read-only document search with structured filters, canonical
  JSON output, and the `docs find` CLI command.

## 0.11.0

### Minor Changes

- [#81](https://github.com/agent-teams-ai/engineering-foundation/pull/81) [`95685d3`](https://github.com/agent-teams-ai/engineering-foundation/commit/95685d3b60a1af4a3c11dd381f3284107ee33177) Thanks [@777genius](https://github.com/777genius)! - Allow empty and single-axis XState evidence profiles and clarify that axis identifiers are opaque, consumer-owned topology.

## 0.10.0

### Minor Changes

- [#73](https://github.com/agent-teams-ai/engineering-foundation/pull/73) [`7bf6e85`](https://github.com/agent-teams-ai/engineering-foundation/commit/7bf6e850e983fdf439417a1640f5d99ae5bbc040) Thanks [@777genius](https://github.com/777genius)! - Add the opt-in `quality.executable-specifications` capability for strict local
  JSON schemas and documents, generated type bindings, independent consumer gate
  bindings, and optional XState artifact connectivity without executing consumer
  scripts. Add explicit development-only source boundaries for truthful tooling
  imports and reject duplicate keys, comments, and trailing commas in governed
  JSON before schema validation. Fence runtime package-name imports from workspace
  packages containing development boundaries, and bound executable catalog
  topology, package discovery, artifact counts, and aggregate inspection bytes.

## 0.9.0

### Minor Changes

- [#67](https://github.com/agent-teams-ai/engineering-foundation/pull/67) [`60ba289`](https://github.com/agent-teams-ai/engineering-foundation/commit/60ba2897891a54f115cdf3c25b9b06496448b8ad) Thanks [@777genius](https://github.com/777genius)! - Collapse provisional Public API, Protobuf qualification and Scaffolding contract
  branches into one current Foundation-owned `v1` while preserving the hardened
  behavior. Remove parallel schemas and compatibility readers, document the
  pre-adoption coordinated-update policy, and add an executable regression gate.

## 0.8.0

### Minor Changes

- [#65](https://github.com/agent-teams-ai/engineering-foundation/pull/65) [`5b3150f`](https://github.com/agent-teams-ai/engineering-foundation/commit/5b3150f670baa171d587417ff4b862f5622080fb) Thanks [@777genius](https://github.com/777genius)! - Add the closed generic Node TypeScript library-boundary scaffolding recipe with
  composition-owned roles, verified owner metadata, varied deterministic fixtures,
  and packed CLI qualification.

- [#59](https://github.com/agent-teams-ai/engineering-foundation/pull/59) [`c922527`](https://github.com/agent-teams-ai/engineering-foundation/commit/c92252788afe9d853d257d678c1810107ef99160) Thanks [@777genius](https://github.com/777genius)! - Add reproducible pinned Buf `FILE` qualification with versioned evidence binding,
  strict normal-check validation, and a real compatibility E2E gate.

  This pre-1.0 minor intentionally requires capability configuration v2 and
  qualification evidence v2. Existing v1 schemas remain published as immutable
  history, but consumers must regenerate qualification evidence through the
  protected command before upgrading.

- [#52](https://github.com/agent-teams-ai/engineering-foundation/pull/52) [`b67b516`](https://github.com/agent-teams-ai/engineering-foundation/commit/b67b51691a74c6c5167b10c7ba836e7a26edbe47) Thanks [@777genius](https://github.com/777genius)! - Replace the provisional scaffolding surface with one canonical source-bound
  Plan, Receipt, and recovery-journal contract. Owner authority is referenced once
  by document ID and resolved deterministically from bounded consumer document
  roots.

## 0.7.0

### Minor Changes

- [#56](https://github.com/agent-teams-ai/engineering-foundation/pull/56) [`1dafac7`](https://github.com/agent-teams-ai/engineering-foundation/commit/1dafac73eb3b27976b88443ad3f595d102981013) Thanks [@777genius](https://github.com/777genius)! - Consolidate `architecture.source-dependencies` into its single `schemaVersion: 1`
  contract while preserving mandatory entrypoints, ambiguous-boundary rejection,
  cross-boundary import fencing, and runtime and type-only cycle checks.

  Consumers using the short-lived `0.6.0` source-dependency schema must change
  `schemaVersion: 2` to `schemaVersion: 1`; their entrypoints and policy remain the
  same.

## 0.6.0

### Minor Changes

- [#46](https://github.com/agent-teams-ai/engineering-foundation/pull/46) [`8abf24f`](https://github.com/agent-teams-ai/engineering-foundation/commit/8abf24f0d4664fd2e87e139caca8b861ca4816e5) Thanks [@777genius](https://github.com/777genius)! - Add deterministic source graph v2, documentation and ADR governance, Protobuf
  and JSON Schema release checks, property-test replay helpers, and hardened
  workflow security qualification.

  This pre-1.0 minor also hardens existing public API compatibility policies.
  Schema v1 consumers must move any custom released baseline to
  `architecture/public-api/<package-local-name>.json`. Breaking-change approvals
  must resolve through the immutable accepted-ADR baseline; raw ADR Markdown is no
  longer sufficient evidence. Follow the migration procedure in
  `docs/architecture/public-api-compatibility.md` before upgrading an affected
  consumer.

## 0.5.0

### Minor Changes

- [#38](https://github.com/agent-teams-ai/engineering-foundation/pull/38) [`a2203d2`](https://github.com/agent-teams-ai/engineering-foundation/commit/a2203d21dad85ea35399ae13842cd354705034dd) Thanks [@777genius](https://github.com/777genius)! - Add the closed deterministic scaffolding protocol, filesystem executor, recovery flow, public schemas, and first conformance-fixture vertical.

- [#40](https://github.com/agent-teams-ai/engineering-foundation/pull/40) [`f65fc4a`](https://github.com/agent-teams-ai/engineering-foundation/commit/f65fc4a1707936f25a9049c0bd1c212ce365d45e) Thanks [@777genius](https://github.com/777genius)! - Add the portable repository agent workflow capability and changed-file preflight runner.

- [#33](https://github.com/agent-teams-ai/engineering-foundation/pull/33) [`f8fd6b6`](https://github.com/agent-teams-ai/engineering-foundation/commit/f8fd6b6672c589cf4f0c209f3bb57048d1049e87) Thanks [@777genius](https://github.com/777genius)! - Publish opt-in production and test maintainability presets with documented,
  conformance-tested size, complexity, nesting, and parameter budgets.

### Patch Changes

- [#32](https://github.com/agent-teams-ai/engineering-foundation/pull/32) [`768a2f0`](https://github.com/agent-teams-ai/engineering-foundation/commit/768a2f04d8e2afb8a37d5cb1889212e3979f33a9) Thanks [@777genius](https://github.com/777genius)! - Accept pnpm catalog aliases only when their target is pinned to an exact semantic version.

## 0.4.1

### Patch Changes

- [#28](https://github.com/agent-teams-ai/engineering-foundation/pull/28) [`9e290d3`](https://github.com/agent-teams-ai/engineering-foundation/commit/9e290d32732d3494edb8300622d002310c145c54) Thanks [@777genius](https://github.com/777genius)! - Accept pnpm peer-context suffixes while preserving exact registry provenance checks.

## 0.4.0

### Minor Changes

- [#23](https://github.com/agent-teams-ai/engineering-foundation/pull/23) [`704ad29`](https://github.com/agent-teams-ai/engineering-foundation/commit/704ad29200b6dfd7765fc34ee91314f42aa6887c) Thanks [@777genius](https://github.com/777genius)! - Add accepted suppression governance, released TypeScript API compatibility, and publishing-repository security capabilities with deterministic fixtures, replay-safe release integration, and explicit consumer adoption gates.

## 0.3.0

### Minor Changes

- [#20](https://github.com/agent-teams-ai/engineering-foundation/pull/20) [`0772e8d`](https://github.com/agent-teams-ai/engineering-foundation/commit/0772e8d4042116a347b6184cf998fd611e312d05) Thanks [@777genius](https://github.com/777genius)! - Add the source dependency architecture capability, type-aware Oxlint preset,
  closed-world boundary conformance, and stronger package-consumer verification.
  Programmatic local-mode service construction now requires an explicit clock;
  the CLI supplies the system-clock adapter at its composition root.

## 0.2.1

### Patch Changes

- [#10](https://github.com/agent-teams-ai/engineering-foundation/pull/10) [`a98a948`](https://github.com/agent-teams-ai/engineering-foundation/commit/a98a948d884f05dba112d1146097f41008615d72) Thanks [@777genius](https://github.com/777genius)! - Reject malformed CLI invocations deterministically, classify an unavailable
  consumer root as invalid input, and map schema-validated configuration into
  capability-owned internal settings instead of maintaining mirror contract types.

## 0.2.0

### Minor Changes

- [#8](https://github.com/agent-teams-ai/engineering-foundation/pull/8) [`a8ccd83`](https://github.com/agent-teams-ai/engineering-foundation/commit/a8ccd83dd97d63ddb8ca8c3c41dfb6e4089403d2) Thanks [@777genius](https://github.com/777genius)! - Add the schema-first executable capability runtime, the
  `workspace.dependency-declarations` pnpm policy, deterministic aggregate reports,
  shared Oxlint and TypeScript presets, and strict YAML configuration. This removes
  the pre-0.2 executable `foundation.config.mjs` API.

## 0.1.1

### Patch Changes

- [#5](https://github.com/agent-teams-ai/engineering-foundation/pull/5) [`0522d33`](https://github.com/agent-teams-ai/engineering-foundation/commit/0522d33d0b96da05fb43f2f0afb8a65e17b11bcb) Thanks [@777genius](https://github.com/777genius)! - Accept the package-manager `--` argument separator in foundation CLI wrappers.
