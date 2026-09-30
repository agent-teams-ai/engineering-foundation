---
id: ADR-0056
status: proposed
supersedes: []
superseded_by: []
---

# ADR-0056: Bounded Qualified Managed Node 26 Transition

Status: Proposed. Decision owner: Product owner. Date: 2026-09-28.

This docs-only proposal is restaged on repaired portable PR347 exact head
`d6f52f71da4fe88f3d200397a3b1f39710fd3346`. Its historical two-path
source diff was authored against Foundation
`bfb08f202e73784f30127e6ecdf1c5bf5ef485b5`, with the supplied exact
organization source archive `25f8704e5727ee90477bd7b673382edb03d054d4`.
At this repaired portable head, the decision-index Git blob is
`4706c30d9ce10521e6c73cf7c540267b9e14128c`: ADR-0055 remains accepted
and no ADR-0056 path is tracked. The initial ADR-0056 proposal commit is
`184e96748682dc6d40c5dacdbab411480e119882`. The portable Node 26 compatibility
policy and its CI lane remain implemented, with Node 24 as production/default; this proposal
adds no managed selection to them. The historical source review compared the
organization Engineering Quality Standard and the complete Get Modular Consumer
Module Standard at `6b31f20` with the accepted, locally pinned Feature Module
Standard. The post-PR119 Get Modular main revision
`d555dfd47d14bf39e30a77737775872cb93ecdbe` has identical complete standard
SHA-256 `d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f`.
The supplied current complete standard has the same SHA-256, so the reviewed
`6b31f20` and post-PR119 `d555dfd4` inputs show no byte delta. Its scoped adoption
text reports Agent Runtime PR #168's passive static Core/Assembly scope and
identifies that consumer's retained `669a750d` revision with complete-document
SHA-256 `e6cd8d26b4317bf5f94ddd22f6e36bf25e90548f72265d94808eaf20b947e553`.
That retained consumer pin differs from the supplied current document digest;
this proposal neither repins Agent Runtime nor infers contained-turn, dynamic
plugin, or repository-wide adoption. The supplied central Engineering Quality
Standard requires exact adopted pins, consumer-owned scope and gates, and separate
evidence for behavior, qualification and release. This content review does not
adopt a moving main or create a second standard.
This proposal does not accept ADR-0052, revise accepted decisions, implement a
route, qualify an artifact, publish a package or select a production runtime.
The first implementation checkpoint is specified below; later checkpoints remain
mandatory for the complete managed path. Current source and central paths are
observations at these exact inputs, while every successor version/name below is
proposed and must be rechecked against the integration head.

## Proposed decision and non-negotiable invariants

1. Implement only explicit Cohort2/Node24 -> Cohort3/Node26 and restoration to that exact recorded Cohort2/Node24 origin. A retained successor controller runs on Node24 and launches selected Node26 children. Legacy Cohort1 must first use its existing independently qualified 1->2 route. Retain each proof/controller separately; never synthesize a 1->3 proof or treat a central edge as executor code.
2. Preserve Node24 production/default, package engine union `^24.18.0 || ^26.0.0`, real engineStrict/strictPeerDependencies enforcement, exact frozen dependencies and historical schemas/cohorts/events/digests/controllers. A managed Node26 qualification lane is not permission to change the production default.
3. Exactly five managed coordinates and exactly three root devDependencies; preserve ADR-0043's sole package DAG. MCP remains outside the managed coordinates. Foundation is never imported into production runtime or used to host managed policy.
4. Node26 behavior belongs to the managed consumer-integration/qualification features. Repository Mutation owns file CAS/journal/recovery; the Host/adapters own child execution, isolation, cancellation and installation resource lifetime. Consumer business architecture, docs, engines and CI prerequisite decisions stay with the consumer.
5. ADR-0052 stays proposed. ADR-0053 remains accepted for its exact strict-JSON admission only. Record this successor's lifecycle as a proposal; do not rewrite historical accepted ADRs or infer acceptance from this authorized planning work.
6. All new formats remain artifact-protected. No JSON Schema family support claim without the separate family/corpus/consumer qualification contract. No new baselines promoted here. No release/cutover, commits, pushes or provider Git writes.

This proposal records scoped refinements of ADR-0032/34 executor binding and ADR-0045 generation
closure, retains ADR-0037 failed-activation compensation, and specifies the ninth-file runtime
transition. It does not silently accept all of ADR-0052. ADR-0056 is free in this exact decision
index and is reserved for this proposal. Recheck concurrent reservations at integration.

## Local public and retained contract reservations

All entries labeled proposed are reservations in this proposal, not published or accepted versions.
Recheck concurrent reservations at integration. Package SemVer is derived by Changesets/release
owner from the actual changed public surface; do not invent npm versions now.

| Surface | Observed | Proposed successor / retained neighbor |
| --- | --- | --- |
| `schemas/qualified-docs-cohort/` | v1/v2, Node24; v2 tuple 3/2/1 | v3, explicit lane/policy/qualified tuple and 4/3/1 schema projection |
| `schemas/docs-consumer-integration-profile/` | v3 refs Cohort2 | v4 refs Cohort3 only |
| `schemas/docs-consumer-managed-state/` | v2 refs Cohort2 | v3 refs Cohort3 only, new managed-state/v3 digest domain |
| `schemas/docs-protocol-qualification-receipt/` | v3, metadata-oriented checks | v4, candidate/runtime/artifact and mandatory behavioral evidence |
| `architecture/contracts/docs-protocol-current-policy/` | v1; policy data 1.0.0; managed 3/2/3 | schema v2 and new explicitly versioned canonical data owned by P1a managed-data lane; generated projection; retain original evidence and coordinate overlapping portable work |
| Packed transition catalog | v1, Node24, no current source executors | separate v2 asset/reader with explicit 2->3 executor and nonrecursive binding |
| Integration plan/execution | v1, opaque Cohort id/five assets | keep v1 wire; add successor internal snapshot/CAS guards only |
| Upgrade/finalize execution | package-owned v1 | keep closed output; proof locators bind new retained families; `blocked` on failure |
| Restoration execution | package-owned v1, `activated-v1` | package-owned v2 with explicit lane semantics and `activated-source`; inverse receipt required for `restored` |
| Retained preparation | `agent-teams.managed-v1-restoration-preparation/v1` | new `agent-teams.managed-runtime-transition-preparation/v1` |
| Retained successful transition | `agent-teams.managed-v1-restoration/v1` | new `agent-teams.managed-runtime-transition/v1` |
| Mutation Plan/receipt/journal and portable protocol | existing public contracts | unchanged; no managed runtime vocabulary in generic kernel |
| pnpm closure | v1 and v2 | retain v2 algorithm/domain only with identical five-coordinate reachability/peer/optional projection; Node binary identity is separate |

Paths in this table beginning `schemas/` are relative to `packages/docs-protocol-agent-teams/`. Use
the exact existing package-qualified namespace for restoration execution v2 and preserve both
historical v1 namespace exports. Every new schema must have its exact `$id`, export/pack inclusion
and locally resolvable `$ref` closure. `scripts/prepare-package.mjs` does not repair schema
identities. Portable `agent-teams.docs-protocol` version 1 and its qualification
entrypoint, plus managed `docs-protocol-qualification/v2`, remain unchanged; a new
managed receipt is not a reason to renumber them.

## Central closure from the supplied exact tree

Central paths here are historical observations at the exact organization commit
`25f8704e5727ee90477bd7b673382edb03d054d4`. Its complete, hash-reconstructed
root tree is `5efc3e80cad98905218f36ff6939684b722f57bd`; the 18 historical
content blobs were separately verified. The named successor candidate schema
and `governance/docs-cohort-candidate` subtree are absent from that tree. Path
absence does not establish the absence of all candidate or Node26 semantics in
other historical files, and neither archive establishes live protected-main state.
The following are concrete additive proposals based on inspected historical readers, not claims that
these versions already exist.

| Actual authority/reader | Observed exact version or constraint | Proposed closed successor |
| --- | --- | --- |
| `governance/docs-qualified-cohorts.schema.json` and `.json` | outer `schema_version: 1`; `$defs/cohortV1`, `$defs/cohortV2`; generation2 Node24/3-2-1/receipt3 | new `governance/docs-qualified-cohorts-v2.schema.json` and `governance/docs-qualified-cohorts-v2.json`, outer 2 with a closed generation3 branch; retain old branch bytes/digest algorithms and old registry for historical readers |
| `scripts/docs-cohort-policy.mjs` | two generation projections, closure domains v1/v2, canonical event/record validation | explicit generation3 projection, record domain `agent-teams.docs-qualified-cohort/v3` and validation; no fallback-to-v1 for unknown generation; append-only source history correspondence and no old-event recomputation |
| `governance/docs-protocol-policy-v2.schema.json` / `.json` | consumer-inventory policy filename v2, outer `schema_version: 3`; `v3QualificationCoordinates` binds profile3/cohort2/state2/receipt3/envelope1 | proposed `governance/docs-protocol-policy-v3.schema.json` and `governance/docs-protocol-policy-v3.json` with outer schema version 4 add generation3 and v4 qualification coordinates; retain old observed state and old consumer authority mapping |
| Named candidate authority | `governance/docs-cohort-candidate/v1.schema.json` and its subtree absent at the exact historical tree; no tree-wide semantic absence claim | new `governance/docs-cohort-candidate/v1.schema.json`; immutable candidate domain `agent-teams.docs-cohort-candidate/v1`, content-addressed candidate evidence, no selectable-cohort status |
| Qualification record/event | existing closed event has no own version field; `agent-teams.docs-qualified-cohort-event/v1` is its digest domain | generation3 event branch with explicit event version 2 and domain `/v2`; bind candidate and trusted receipt/evidence identity, retain the old branch's exact bytes/domain; no global reinterpretation of old events |
| `scripts/verify-docs-consumer-gate.mjs` | Cohort2 authorization schemaVersion2, domain `agent-teams.docs-consumer-gate-authorization/v1`; profile `cohort-v2`; packageManager11.20.0 | new authorization schemaVersion3/domain `/v2`, explicit profile `cohort-v3`, exact runtime/policy/candidate/authority/workflow bindings; existing v1/v2 readers remain exact |
| Same script: install evidence | schemaVersion1, authorization digest and package tree identities | install evidence v2 adds observed Node/pnpm executable identity, true enforcement observations, exact closure, source and target roles; keep v1 reader |
| `scripts/verify-docs-cohort-v2-receipt.mjs` | receipt3 and `agent-teams.docs-cohort-v2-execution-envelope/v1` | additive `scripts/verify-docs-cohort-v3-receipt.mjs`; receipt4 and new `agent-teams.docs-cohort-v3-execution-envelope/v1`; immutable checkout/workflow/run, authorization/install/receipt digests and runtime are mandatory |
| `scripts/verify-docs-qualification-receipt.mjs` | legacy envelope2/receipt2, released-cohort | retain unchanged branch; never use it to interpret managed receipt4 |
| `scripts/verify-docs-cohort-evidence.mjs`, `scripts/verify-docs-admission-change.mjs`, `scripts/check-cohort-append-only.mjs` | old registry/schema are defaults for evidence and append-only readers; the evidence reader accepts `--registry`/`--schema`, and append-only accepts `DOCS_COHORT_CURRENT_PATH`, `DOCS_COHORT_BASE_PATH`, `DOCS_COHORT_SCHEMA_PATH` while its Git-history lookup retains the old registry path | route generation3 to exact new schema/registry/evidence and require full prior history retention; generation1/2 retain their paths and digest semantics |
| `.github/workflows/docs-protocol-check.yml` | historical trusted authorize/structural/qualification/semantic jobs use Node24.18.0; a separate central-tooling matrix includes Node26.10.0, without demonstrating managed Node26 execution or universal required-job aggregation | lane-aware managed execution/semantic jobs with closed authorized tuple; trusted structural Node24 remains distinct; preserve OIDC isolation, frozen workflow pins, install verification and required aggregation |

The versioned successor registry must explicitly retain a byte-bound predecessor identity and
include or resolve all earlier immutable records/events needed for allowed upgrade/rollback origins.
New readers cannot join unrelated registries by a floating URL. Every historical record/event object
and chain value remains identical. Existing Node24 consumers keep their exact old
workflow/controller and old authority behavior during coexistence; the successor registry is not a
reason to remove old enrollment/support evidence. Versioned registry coexistence is a technical
contract, not a second writer for a consumer. Update the managed authority adapter's expected
central path only in its explicit new-generation reader.

Reserve the full matching candidate paths explicitly:
`.github/workflows/docs-cohort-authority-evolution-v9.yml` /
`scripts/docs-cohort-authority-evolution-v9.test.mjs`,
`.github/workflows/docs-qualification-authority-evolution-v13.yml` /
`scripts/docs-qualification-authority-evolution-v13.test.mjs`, and
`.github/workflows/docs-governance-authority-evolution-v14.yml` /
`scripts/docs-governance-authority-evolution-v14.test.mjs`. These files are absent
from the complete historical tree above and are proposed names only; actual scope
depends on which predecessor guards protect the integrated diff.

Runtime closure v2 central source pins `pnpm@11.20.0` (`docs-cohort-policy.mjs:8`); v1 retains
11.18.0. Do not call a different package manager compatible merely because it matches >=11.17.0 <12.
Qualification binds its exact tuple; a future tuple needs separate immutable evidence. The proposed
first test will use provisioned Node24.21.0/Node26.10.0 with pnpm11.20.0. Source-specific Node24/pnpm exact
pins are retained, not replaced by examples.

The historical registry records `docs-2026-09-25-stable29` as generation2, last event
sequence179 QUALIFIED, with packages repository-mutation0.2.1, document-authoring0.3.1,
docs-protocol0.6.1, managed0.2.12, Foundation1.6.0. It binds workflow revision
`757122cb08ed15aba6c9eef1b1f655b77d1ac54b`, blob `9bcbe54dfec6280045ac596e55c1f14ce5f176e1`; record
digest `sha256:8e1f30c3d2e83c74e3a31bf3be001918d0ccac5c682b1300777c52af052d30b9`; event digest
`sha256:2e4d4573a5e9a2a667cf4067956075c2a0a714871162a35fb2e6d1cc7afa37d3`. Its archive record
contains SRI/provenance fields and a closure digest. The record and event digests
were independently recomputed from the supplied bytes. These observations establish
internally consistent recorded metadata for a generation2 origin to assess; they do
not independently prove the referenced publication/qualification evidence, package
archives, older workflow execution, selection, deployment, future rollback support
or Node26 qualification. Do not reuse its Node24 workflow pin for a claimed new lane.

### Central authority evolution and qualification workflow delivery

The historical tree contains `.github/workflows/docs-cohort-authority-evolution-v8.yml` with
matching `scripts/docs-cohort-authority-evolution-v8.test.mjs`, qualification evolution v12 and
governance evolution v13 with matching tests. These are finite, exact reviewed path/blob tuple
guards, not generic permissions. Cohort v8 explicitly says it cannot authorize its own
introduction/modification; it checks the exact forward/inverse tuple for prior PR303. Qualification
v12 accepts a specific stable10 inventory slice; governance v13 a specific exception-boundary test
slice. None automatically admits this Node26 change.

If additive successor guards are needed, next observed-free proposed paths are cohort evolution v9,
qualification evolution v13, governance evolution v14, each with its matching test. Those are
proposal reservations after inspecting this supplied tree, not assumed active required contexts or
automatic approval. Recheck active guard dependencies and concurrent paths at integration. Do not
rewrite an old allowlist into a wildcard, exempt authority paths, edit an old exact blob tuple, or
claim a self-introduced guard approves its own activation. Use the existing exact
predecessor/successor authority procedure with the actual final changed-path set, observed base/head
blobs, tests and exact inverse. This review does not fabricate future SHA values or required-check
configuration, and it imposes no extra human approval ceremony beyond the existing authorized work
and real provider restrictions.

The successor workflow implementation must close the following call sites together.
The historical workflow does not bind `.node-version` in its authorization list;
its `prepare-install` writes `strict-peer-dependencies=true` but does not itself
set `engineStrict`/`engine-strict`, while its separate compatibility matrix passes
both strict flags. Its semantic job is Node24 and depends on trusted qualification,
not the compatibility matrix. Required aggregation below is a proposed gate, not
an observed active required context at the historical commit:

1. `authorize` reads protected current central authority at one revision; validates repo identity, caller workflow identity, generation, policy, explicit source/target edges and exact candidate/artifacts. Keep the OIDC-only authorization job from executing consumer code. New candidate qualification has its own trusted selection and cannot enter ordinary consumer enrollment before admission.
2. `verify-checkout` binds exact consumer bytes and `.node-version` to authorization. `prepare-install` constructs a fresh isolated graph with true engineStrict/strictPeerDependencies; preserve exact roots, release-age exceptions, registry/SRI and closure. `verify-install-lock` rejects graph substitution before execution.
3. Provision the exact selected runtime; independently observe Node, pnpm and executable/package digests. Use that Node to launch pnpm and installed managed target behavior; ambient Node24/`process.execPath` cannot substitute. `verify-install` binds actual package trees and manifest identities before invoking released code. Recheck identities after effects.
4. Add a closed `run-qualification-v4` trusted runner and matching receipt-v4 verifier rather than widening the consumer `qualify` CLI. Run fresh managed behavior fixtures, not merely metadata projection or a package import. All mandatory cases and observed runtime identities must match the selected candidate.
5. Bind authorization + install evidence + receipt + exact checkout + workflow revision/blob/run/attempt in the new execution envelope. Keep a receipt's supporting evidence class distinct from central CANARY. Recheck protected controller snapshot after structural and behavioral validation.
6. The final semantic consumer gate selects the same authorized lane and exact package manager; it must not stay hard-coded Node24 for a Node26 admission. Required aggregation refuses missing, cancelled, skipped or failed applicable jobs. The existing central tooling compatibility matrix remains its own evidence and cannot satisfy this managed workflow.
7. Before central QUALIFIED promotion validate immutable published versions/SRIs/provenance, prior source bundle/executor compatibility, candidate receipt and installed closure. Before CANARY/RECOMMENDED use real central canary/check-run evidence under its existing identity/protection policy. A local receipt, a successful consumer command or an arbitrary workflow output cannot enroll or promote itself.

### Acyclic candidate binding

Cohort3 carries `candidateDigest` in its closed core, and state3 carries that binding in its
authority projection; neither field alone authenticates admission. One immutable candidate contains
exact source SHA, package artifact coordinates and manifest digests, schemas, assets/catalog/policy
digests, selected runtime tuple, explicit source/target direction, workflow revision/blob and
scenario-inventory version. Its domain-separated digest excludes the future qualification event
digest and future final record digest. A trusted producer observes the candidate's behavioral cases
and emits receipt4. Central verifies this evidence, then appends generation3 authority and an event
binding that exact candidate/receipt. A final record projects back to exactly the same candidate
digest. Ordinary consumer receipts may subsequently bind the admitted record/event. Reject any
mismatch, placeholder digest, self-reference, pre-admission receipt pretending to be enrolled, or
reuse of consumer supporting evidence as CANARY. Package provenance/released source identities and
runtime bindings remain explicit; candidate digest alone is not authentication.

## Lane, policy and artifact closure

Cohort3 binds one selected lane, never a union with implicit preference:

```
policy: { id, version, digest }
selectedLane: node-24-production-default | node-26-managed-qualified
node: >=24.18.0 <25 | >=26.0.0 <27   # determined by selected lane
pnpm: >=11.17.0 <12
qualificationRuntime: { nodeVersion, pnpmVersion, platform, architecture }
runtimeClosure: { domain: agent-teams.docs-runtime-closure/v2, digest }
```

The first executable route requires source generation2/Node24 and target generation3/Node26. Schema
representation of a Node24 lane does not grant 3->3 or arbitrary same-runtime execution. The managed
Node26 lane is distinct from portable `node-26-compatibility`; neither changes Node24 default.
Platform labels have an explicit mapping (`darwin` observation to authority `macos`), no unchecked
alias equality.

The canonical versioned current policy owns the lane table. The managed package includes a
deterministic generated projection and digest from that authority so installed code never imports
repository-only `architecture/`, Foundation or floating remote policy. Record generator/source
ownership and generated counts. P1a owns the canonical policy v2 successor and the managed
projection as one data closure, coordinating overlapping portable work without overwriting its
changes. The projection is a cache of authority, not another normative source.

Trusted observations bind executable realpath plus bytes, actual Node version,
platform/architecture, actual pnpm version and package/executable identity under that Node, and
Corepack identity when used. Paths and declared version strings do not prove execution. Bind clean
source SHA/tree, repository/root/physical identity, files/modes/ignored inventory, exact five
package versions/SRIs/packed manifest hashes, source provenance, policy, schema tuple, workflow,
assets/catalog and observed closure. Compare the qualified exact tuple at
install/check/qualification, not merely a major range. New Node26 minors/platforms need new
evidence; package engines alone confer no managed runtime qualification.

Packed catalog v2 bundles immutable prior Cohort2 coordinates/assets and names the built-in 2->3
executor and target asset/schema projection. It excludes its own future tarball SRI and final
admission event. Externally selected preparation/evidence binds the retained successor package's
real SRI/build/kernel identity and target authority. No self-SRI cycle, plugin executor, bridge,
extra managed coordinate or editable historic catalog. Retain controller, exact kernel, source Git
objects, source/target tarballs and offline store throughout support.

## Narrow ownership and dependency direction


Evaluate reuse at the semantic owner before adding machinery:

| Responsibility | Recommended owner / boundary |
| --- | --- |
| Managed lane/cohort selection, allowed transitions, source/target equality, qualification completeness | Pure policy and models in managed consumer-integration; curated feature API for managed qualification. One authoritative mapping, no Foundation-wide generic runtime-policy service. |
| Wire schema and nominal contract identity shared by authority reader, managed integration and qualification | Managed package's closed contracts; `.github` maps its own authority DTOs explicitly. Small erased branded identities can distinguish policy, source selection, completion proof and candidate digest, but require existing feature/primitive ownership review; brands never replace validation. |
| Strict JSON and canonical evidence encoding | Existing Repository Mutation public contracts, within ADR-0050/53 admitted caller identities. Preserve old digest algorithms. New primitive consumers need successor admission; no duplicate parser or provenance-hiding facade. |
| Process lifetime, explicit Node/Corepack/pnpm executable selection, cancellation, bounded output, exit observation and cleanup | Node/OS adapters assembled by the existing managed CLI Host/composition; application declares the narrow observations/activation ports it consumes. Host cannot decide eligibility or interpret restoration proof. |
| Cooperative lease, CAS files, journal, original receipt and recovery | Repository Mutation unchanged; new workflow uses public APIs. No second transaction engine or public universal SPI. |
| Release/canary trusted receipt creation and central admission | Existing release qualification plus organization governance; consumer hooks are never invoked to manufacture successful evidence. |

Prefer a feature-private runtime process adapter with explicit dependencies and
thin composition over a new package. A reusable supervisor extraction into
Foundation would require two real consumers with identical semantics, parity
fixtures and consumer conformance/deletion of duplicates. This review does not
establish that admission. Never import Foundation into product runtime; do not
create a reverse portable-to-managed dependency. Preserve the ADR-0043 DAG.

The complete pinned CMS comparison input above describes this boundary. Its
`Consumer module standard`
sections allow fixed private helpers and typed factories within a cohesive
feature; require one composition authority and consuming-owner ports at real
independent/configurable seams; and assign permissions, resources, readiness,
deadlines and lifecycle to Host. Its construction API explicitly owns no retry,
automatic rollback, disposal or runtime generations. Therefore importing Assembly
would not supply the managed process supervisor or restoration protocol.
Foundation's accepted FMS profile remains the applicable local architecture pin;
this comparison neither adopts Assembly nor certifies repository-wide CMS
conformance. If integration later creates an independently assembled capability
inside accepted CMS Host scope, that owner must map the seam under its local
adoption profile rather than hide it as a private helper.

Keep these inputs and outputs narrow in the existing owners (proposed internal
contracts, not a new public process API):

| Boundary | Required explicit input | Result / refusal |
| --- | --- | --- |
| Pure lane validation | Versioned policy projection, selected lane, exact qualified tuple, observed tuple | Validated lane binding or stable mismatch; no PATH, environment or process reads |
| Authority mapping | Validated central candidate/event/cohort DTO, expected protected revision, exact managed projection | Managed selection with source authority references; reject mixed generations, stale revision or different candidate |
| Runtime observation port | Host-selected opaque runtime handle and expected executable/package identity | Actual Node/pnpm/platform/architecture and artifact digests, or refusal; handles stay adapter-owned and never serialize as proof of execution |
| Activation port | Explicit source/target role, validated runtime binding, consumer root, exact manifest/lock/artifact expectations, cancellation | Observed install and installed-CLI results, bounded diagnostics, termination/cleanup state; exit zero alone never means current |
| Transition policy | Validated source/target bindings, exact scope/inventory, independently selected preparation or final proof | Closed 2/24 -> 3/26 forward Plan or proof-selected inverse; no file IO or process supervision |
| Qualification owner | Immutable candidate projection, trusted observations from every mandatory case, expected artifact identities | Receipt v4 and digest, or incomplete/refused; never eligibility or rollout permission |

Use feature-owned nominal identities for different digest meanings only where
that feature owns the invariant. A separately reusable Shared primitive needs
explicit admitted owner/consumer records, semantics, purity/versioning and parity
fixtures; a shared string representation is insufficient. In particular the
existing primitive admission lists consumer-integration, not managed-qualification,
for these JSON uses. Any direct new qualification caller requires admission;
placing a relay in consumer-integration cannot launder that new caller identity.
Source policy and negative imports must prove the chosen feature API direction.
Host registers each owned child/store/temporary-root cleanup at acquisition,
reaps or fences the child before releasing its mutation exclusion, and reports
unresolved debt after cancellation/death. No timeout is proof of process death;
POSIX process groups do not contain deliberately detached sessions. Qualification
must exercise the actual supported cooperative-child containment, while retaining
manual refusal for uncertain liveness. Do not introduce another global registry,
generic supervisor framework or cleanup authority in policy code.

## Executable forward transition and exact inverse

The following is the operational contract for later implementation, not commands available in this
proposal. Selection explicitly provides generations, source/target Cohort IDs, source/target runtime
handles and preparation/final digest. No inference from PATH, installed package count or
environment.

1. Verify clean exact generation2 source on its real installed Node24 CLI, complete inventory/modes, idle kernel barrier and qualified closure. Read fresh protected authority, eligible/enrolled target, explicit upgrade origin and exact inverse/support eligibility. `eligible_after` stays informational. Check the external successor controller/catalog and exact historic target bundle before any effect.
2. Prepare in a NEW disposable Git copy. Explicit target Node26 executes provisioned pnpm and actual target CLI. pnpm alone generates the lockfile with scripts/hooks disabled, true strict flags and fresh lane installation. Preserve foreign graph semantics and lock comments. Source/target runtime observations and artifact identities are recorded independently.
3. Scope is the eight existing restoration files plus existing `.node-version`: profile, manifest, lock, state, Skill, caller workflow, AGENTS managed route, existing workspace policy and runtime pin. No create/remove; preserve exact modes and all non-owned fields/comments. Ordinary plan/apply may repair only its five assets and guards runtime as a prerequisite. Consumer prerequisite engines/CI changes happen separately before this operation. Git-archive modes must remain reproducible; no broad source checkout restore.
4. Enforce kernel limits: <=32 operations, <=8 MiB each image, <=16 MiB aggregate raw image evidence plus actual serialized journal bounds. Preparation/final proof <=24 MiB. Nine paths fit the count ceiling but do not exempt byte bounds. Bind all pre/postimages, physical root, source Git, complete inventory, runtime/policy/artifact/authority/controller/kernel/catalog/workflow identities in the strict retained preparation outside consumer/controller. Exclusively create/sync it and independently retain its digest before finalize. Preparation alone never grants post-success inverse.
5. Finalize revalidates source or exact selected target images, authority freshness and binary identities. Acquire the operation exclusion and kernel claim; publish exactly the prepared public Plan. Every retry invokes public apply and reports that attempt's honest receipt. Keep actual fully-replaced original receipt separately when retained. Clean the file journal before old/new CLI checks, while maintaining owned activation exclusion. Run target frozen offline install/check under selected Node26 with original exact pnpm semantics, disabled Corepack network, scripts and hooks. No `--force`, false config override, cross-lane modules, changed HOME or runtime substitution.
6. Revalidate all target bytes/modes/inventory/runtime and successful current CLI outcome plus exit zero. Exclusively retain/sync final proof under its new protocol/domain, binding preparation, completing receipt, optional authentic original receipt and actual activation. Return independently retainable final digest. Partial or colliding files/companions stay intact; explicitly choose a fresh destination. A lost stdout replay must actually apply/revalidate/reactivate and may return the existing complete proof digest without rewriting its history. A successful digest selected from preparation never authenticates an invented completion.
7. Restore accepts only an independently selected successful final digest and exact recorded origin. Strict parse rejects duplicates/unknown keys/noncanonical values; reconstruct every Plan and receipt and validate whole target inventory, physical root, source Git, artifacts and fresh support/rollback authority under the lease. Publish exact inverse. Cleanup COMMITTED before source activation. Run real original Node24/pnpm offline frozen install and original released CLI, verify original bytes/modes/ignored inventory/runtime pin, then report `restored`. A source activation-only retry requires exact source images and idle kernel, performs no inverse, and reports only `activated-source` after successful install/check.

## Failure compensation, retry and process debt: mandatory correction

Preserve ADR-0037's known failed-activation compensation without inventing ownership. A forward
completing receipt which proves every prepared replacement, or a separately retained original
fully-replaced receipt authenticated against that same preparation, may authorize the exact
receipt-owned reverse after checking target images and process termination. Then install/check
original Node24 source. The original upgrade still returns `blocked`, nonzero, and a stable
source-restored diagnostic, never `upgraded`. A failed compensation/source activation returns
recovery-required debt and preserves all evidence/backups.

An `already-satisfied` replay does not prove any replacements. A mixture of
replaced/already-satisfied is not blanket ownership. If the original replacement receipt was lost,
selected replay may reattempt target activation/final proof but cannot manufacture original history
or authorize receipt-owned failure inversion. If activation again fails, report recovery-required
debt and retain selection, target images and module backup. Successful real activation can yield the
new independently selected final proof and permit later proof-selected restoration; failure cannot
skip this requirement. Do not weaken this into an empty rollback returning success. Supporting an
additional lost-receipt abort route would require an explicitly different contract and independent
tests; it is outside this narrow proposal.

Post-success restore remains a separate use case requiring final proof, exact inverse and fresh
authority. Kernel recovery is neither compensation nor that restore. If any owned child may still be
running, fence/reap or independently observe termination first. A timeout, cancellation request or
controller death is not termination evidence. Protect installation/backup ownership with a
feature-private, identity-fenced operation exclusion compatible with an idle file journal; report
uncertain liveness and cleanup debt. Never delete a backup needed to recover the last verified
installation, start overlapping installs or release another attempt's resources. POSIX group
containment covers cooperative children, not arbitrary detached sessions; stronger hostile
containment is outside this claim.

The private activation adapter retains a bounded operation/debt record outside the consumer and
controller installation. It binds an unguessable attempt token, canonical root/physical identity,
preparation digest, controller identity, child PID plus start identity/containment boundary,
source/target role, exact runtime handles/observations, installation and backup
locations/identities, current phase and last observed exit/termination/cleanup facts. Acquire
exclusively before spawning; release/remove only the same token and record identity after child
termination and resource handoff. On restart, reconcile actual files/process/installation against
this record; PID alone is insufficient because of reuse. An absent observer or unverifiable process
owner means refusal/debt, never takeover. Only attempt-owned staging/backup artifacts may be
cleaned. This record provides process/installation ownership and diagnosis, not a second file
transaction log or authority to synthesize an inverse. All new managed lifecycle routes honor the
same exclusion; it makes no claim of containing arbitrary OS writers or an old command that ignores
it. The existing cooperative-writer precondition forbids concurrent manual/historical mutation
during this operation.

Use distinct stable successor diagnostics (proposed names) for
`DOCS_MANAGED_ACTIVATION_FAILED_SOURCE_RESTORED`, `DOCS_MANAGED_RECOVERY_REQUIRED`,
`DOCS_MANAGED_PROCESS_LIVENESS_UNCERTAIN`, `DOCS_MANAGED_RUNTIME_BINDING_MISMATCH`, and
`DOCS_MANAGED_COMPENSATION_RECEIPT_REQUIRED`. Each is a nonzero blocked outcome with the retained
evidence location and no false successful receipt. Cleanup failure remains visible even if file
publication succeeded. No new generic process SPI or policy-level resource ownership follows from
this adapter record.

| Observed boundary | Required result / next action |
| --- | --- |
| Preparation only, no CAS | Original source; selected retry permitted; no inverse authority |
| Forward APPLYING | Exact retained controller/kernel recovery restores Node24 source files; reconcile process/module debt before retry |
| Forward COMMITTED | Cleanup preserves Node26 target files; selected finalize performs real activation, no automatic COMMITTED undo |
| Target activation fails, full replacement receipt available, child dead | Exact receipt-owned compensation, original Node24 install/check; `blocked` with source-restored evidence, no final success proof |
| Target activation fails, receipt absent or only already-satisfied | Preserve target and installation debt; selected activation retry, no speculative inverse |
| Success proved, inverse APPLYING | Kernel recovery restores target Node26 images; retry explicitly selected inverse |
| Inverse COMMITTED/source activation fails | Cleanup leaves Node24 source images; source activation-only retry, no second inverse |
| Unknown journal/build, changed root/files/runtime, uncertain child liveness | No new mutation or fabricated success; preserve evidence and owned-resource debt |

Retain old Node24 controllers for their own old journals/builds. The new controller may never claim
historical recovery because a newer schema happens to parse. Windows is check/plan-only until
separately qualified; Linux process-death evidence grants no Windows apply or macOS durability.
First operational qualification claims only its actual OS/architecture/filesystem tuple.

## Qualification and rejecting evidence


Implement cases in existing managed consumer-integration/qualification owners and
their test directories; update `tests/manifests/test-shards.v1.json` and production
coverage authorities when adding tests. Retain present source scope and thresholds.
Useful existing oracles include `consumer-managed-state-schema`,
`canonical-managed-state-v2`, `qualification-v3`, `qualification-cli-v3`,
`consumer-upgrade-authority`, `consumer-upgrade-v3-projectors`,
`consumer-restoration-cli`, restoration selection/finalization cases, historical
execution fixtures and public managed registry canary tests. These tests need
successor-specific extensions, not changed historical expectations.

| Area | Positive evidence | Rejecting evidence |
| --- | --- | --- |
| Version closure | Old readers preserve old schema/output bytes; new profile 4/Cohort 3/state 3/receipt 4 closes all refs, exact `$id`s and guards; packed imports succeed | Every mixed profile/cohort/state/receipt pairing; unknown versions; legacy protocol mislabeled as successor; namespace confusion; widened old schema; missing ref/extra key |
| Runtime identity | Exact selected target Node/pnpm observed during install, check and qualify, same candidate bindings throughout | Node 24 launching a claimed Node 26 target; Node 26 running legacy-only path; wrong pnpm/architecture; version assertion without observed binary; PATH switch, executable-byte swap or wrong `.node-version` |
| Dependency enforcement | Each lane installs fresh with effective engineStrict and strictPeerDependencies true, frozen exact final lock | Incompatible engine and unsatisfied peer are two actual install failures; env/flag/config false override; `--force`; reused cross-lane modules; mismatched root and virtual-store lock; tampered SRI; unauthorized transitive edge |
| Trust/admission | Fresh protected authority, exact artifact/candidate/closure/schema/workflow/catalog bindings | Stale main, unsupported/suspended target, unenrolled canary, absent upgrade/rollback edge, self/duplicate edge, central edge without source executor, self-referential event, forged candidate or local receipt |
| Consumer preservation | Three exact root entries, five closed coordinates, exact non-owned fields/comments/modes and complete inventory | MCP as sixth coordinate, extra root, foreign dependency graph or documentation edits, symlink/hardlink/path escape, changed runtime file, ignored-file drift, transplanted root/repository |
| Successful transition | Actual old installed CLI on Node 24 -> actual new installed CLI on Node 26, qualified source/target closures, retained independently selected final digest | Target check emits success with nonzero exit; missing installation observation; fabricated completing receipt; preparation used as completion |
| Forward crash | Kill actual controller at APPLYING, COMMITTED before proof, during install and after final retention; recover/retry with exact controller | Wrong kernel build, mixed files after recovery, deleting unknown journal, false success after cancellation/timeout, overwritten partial/colliding companion |
| Inverse crash | Post-success restore to exact Node 24 source, kill inverse APPLYING/COMMITTED, activation failure then activation-only success | Restore without final selection; stale target or unrelated edits; inverted COMMITTED semantics; old proof reinterpretation; install failure reported as restored |
| Permission/retention | Actual EFBIG/EACCES finalization failures preserve evidence; exact authorized retry and lost-stdout retrieval | Root-bypassed chmod test, changed umask after expected files, missing independently retained selection, fabricated final proof from intact intent |
| Historical recovery | Old Node 24 controller/kernel installed externally recovers original old journal fixtures; old receipts remain byte-identical | Successor attempts to read unknown old/new journals; removing old executor while a supported journal can reference it |

Managed qualification uses a **new disposable managed consumer per lane/scenario**,
with real installed packed or hermetic-registry candidate artifacts and an explicit
test identity. A local fixture can prove behavior, but published source/target
SRI/provenance and live protected central admission need separate release evidence.
Run the normal portable info/find/preview/apply/check/doctor/recover suite in its
own fresh fixture; it cannot replace managed upgrade/finalize/restore cases.
Agent/launch/provisioning/terminal/assignment/smoke flows are outside this managed
design; if another owner runs them, only NEW disposable fixtures may be used.

Retain exact command, cwd, uid/groups, source SHA, artifact digests, Node/pnpm
versions, fixture identity, case names/counts, exit status and logs for each run.
Permission tests must set `umask 022` **inside the unprivileged shell after sudo**,
prove a real denied write before the cases, then show the exact finalization
selection **3/3 passed**. The user's reported actual 3/3 result is preserved as
reported prior evidence, but no log/run handle was supplied here and this proposal
does not independently authenticate it or transfer it to new candidate bytes.
Fresh successor qualification must reproduce or supply exact-input-valid evidence.


Add specific rejecting cases for retry compensation: kill before original receipt retention; replay
yields only already-satisfied; force target activation failure; assert no inverse, no success proof,
backup retained and recovery-required. With authentic full original receipt, fail target activation
and prove exact Node24 compensation. Include source-compensation install failure and process
survival past timeout. No generated oracle may turn already-satisfied into replaced.

Central additionally rejects event-before-candidate cycles, unknown authorization/install/envelope
versions, admission receipt masquerading as CANARY, stale controller snapshot, mismatched called
workflow blob/run/attempt, wrong candidate and old Node24 hard-coded execution. Preserve original
supporting receipt3 bytes/digests and all historical authority tests. A positive new lane must show
exact candidate -> observed install -> real managed behavior -> receipt -> central verification,
with future live release/admission explicitly separate.

## Dependency-safe delivery checkpoints

| Checkpoint | Depends on | Coherent deliverable and rollback |
| --- | --- | --- |
| P0 | Exact Foundation/CMS/central source review | This docs-only proposed ADR and complete reservations/semantics. No accepted-status claim or activated edge. Remove unaccepted proposal only; historical ADRs untouched |
| P1a | P0 + coordinated policy ownership | Complete unselected Cohort3, canonical current-policy v2 schema/data and generated managed projection closure, with loader, packed refs and rejecting tests. Revert this additive unit before selection |
| P1b | P1a | Complete unselected profile4/state3 schema-model-projector-loader closure and rejecting tests. P1a plus P1b use the measured allowance below, with no runtime effects or dangling receipt reference |
| G1 | P0/P1 contract | Central registry/inventory/candidate/auth/install/receipt/workflow readers and exact guard successors with rejecting tests; split by closed reader/workflow seams. No selectable Node26 record yet |
| P2 | P1 | Feature-private explicit runtime observation/process adapter and bounded ports, real negative engine/peer fixtures; no public process SPI |
| P3 | P1/P2 | Catalog2, snapshot/runtime/workspace CAS guards and installed pack closure; offline check/plan only, original five repair assets |
| P4 | P3 + G1 parity | Disposable staging, nine-path scope, immutable preparation strict reader/producer and independent selection; no live mutation |
| P5 | P4 | Finalize/activation, original-vs-completing receipts, receipt-owned failure compensation and process debt; fault cases, no exposed selectable route yet |
| P6 | P5 | Exact proof-selected inverse and Node24 source activation-only retry; fresh full round trip and crash/refusal cases |
| P7 | P2-P6 + G1 producer/verifier agreement | Receipt4, managed behavioral runner, actual runtime/artifact/candidate bindings, mandatory case inventory; portable qualification only a component |
| P8 | P7 + relevant integrated portable compatibility result | Exact-head package/exports/ref/schema guards, API/artifact proposals, CI/manifests/coverage, historical and registry-install evidence; normal full verify; no publication here |
| G2/consumer preparation | Exact qualified released artifacts and existing owner release procedure | Append-only central admission and consumer-specific runtime packets, live protected checks, support and rollback evidence. Release and cutover remain excluded by this task |

Aim each checkpoint after P1b below 2,000 authored additions+deletions, counting hand-written
schema/test/docs. Split at closed API/reader/test seams, not by dropping safety tests. Generated
output may be excluded only with named deterministic generator/input hashes/rebuild diff and its own
separate count. Never add a stub dispatch or generic flags framework: withhold the new operational
CLI selection until inverse and qualification exist.

Every future implementation checkpoint uses focused tests, `pnpm check:changed`, `pnpm check:fast`,
and `pnpm verify` before a PR as required. Preserve full production source coverage and test
manifests. Do not repeat those gates for this unchanged-source artifact repair; existing
portable/root verification remains separately owned. Do not shrink governed roots, add pending-root
exclusions, widen suppressions or edit release-owned historic baselines. Source contracts and exact
rollback evidence, not a green partial test, define completion.

## P1a and P1b: first dependency-safe data checkpoint

P1 is split into P1a followed by P1b. P1a owns the complete unselected
Cohort3 schema/model, canonical current-policy v2 schema/data and exact
generated managed projection closure with its loader, packed refs and rejection
tests. P1b owns profile4/state3 schema/model/projector/loader closure and
rejection tests over the P1a authority. Neither checkpoint selects an
operational path; both together satisfy the P1 data deliverable. The combined
authored additions plus deletions remain at most 2,500 under the owner decision below. Do not count a
nonclosing half as complete P1 or publish a schema with a dangling reference.

## Deliverable and hard boundary

Deliver a fully loadable, strict, deterministic and unselected managed data
contract for Cohort3/profile4/state3 plus canonical current-policy v2 and its
packed managed-runtime projection. Validate and project it with independent
rejecting fixtures while preserving every old schema/reader/output. At most
**2,500 authored additions plus deletions across P1a and P1b**, including
schemas, tests, configuration, exports, docs and Changesets.
Full P1 `87fbf3e1183c5f2bce296c6bbdcabce99dd7c7fe` against parent
`33de70fba708b0a03206bade3ce2d5a97e75d7b1` measured 2,209 raw: 2,086 authored
and 123 generated (59-line asset, 64-line schema). Exclude those 123 only with
a byte rebuild by `packages/docs-protocol-agent-teams/scripts/generate-runtime-policy.mjs`
from canonical input SHA-256 `4db0b267a08c75d22eeddde9bdf69b70c0da0b165bb13e18d6e685df4a5cd801`.
Recount final PRs with docs and Changesets; no other exclusion applies.

Owner decision (2026-09-29): adopt the 2,500 combined P1a/P1b authored-line
ceiling after review of approximately 2,435 authored additions plus deletions.
The canonical packed projection asset name is `runtime-policy.v1.json`.
ADR-0056 remains Proposed; this decision does not accept the broader transition.

P1 does not install, spawn, mutate a consumer, dispatch upgrade/finalize/restore, emit receipt4,
select central generation3 or expose an incomplete public runtime API. It is a useful closed
contract compiler/reader, not a stub workflow. No registry fetching or ambient runtime discovery. No
policy `default` or `cutoverAuthorized` change. Future receipt/transition/catalog/central versions
are reserved in P0 but have no unresolved `$ref` or placeholder implementation here.

The full managed migration contract remains P0/P2-P8/G1-G2. Inverse, actual qualification and
central workflow closure remain mandatory before selecting the operation.

## Owner, inputs and dependency direction

The semantic owner is `docs-protocol-agent-teams/consumer-integration`. Its domain owns
generation/lane/cohort identity and exact value invariants; application owns state projection and
validation coordination; outbound/inbound adapters own schema file loading and JSON/IO. Node
composition later supplies runtime handles. No Node/fs/process/framework import in
domain/application; no consumer business vocabulary enters Foundation.

Use existing consumer-integration feature entries in `architecture/foundation/feature-modules.json`
and `architecture/foundation/source-dependencies.yaml` (verify current exact profile path before
editing). Generated policy assets use the existing generated asset ownership mechanism.
`src/consumer-integration/application-api.ts` is the curated feature boundary; publish only the
narrow functions actually consumed. Managed qualification later consumes this explicit API rather
than deep-importing domain/adapter files. Domain never imports qualification or a central snake-case
DTO.

Use existing Repository Mutation canonical encoding through public imports with exact admitted
feature identity. Same-owner exact caller additions require their normal profile/test updates.
ADR-0053 does not admit a direct new qualification caller; if one is needed later, record its actual
primitive consumer admission rather than hiding it behind a provenance-free forwarding facade. Do
not invent Shared brands, a policy service or a reusable process package. Feature-private digest
types may distinguish policy/candidate/state identities but do not replace runtime parsing or
central authentication.

The pinned CMS text permits this fixed cohesive helper/factory boundary. Host would own independently
assembled runtime execution and cleanup later. Foundation's accepted FMS profile remains the
governing local architecture pin; no new Core/Assembly dependency or silent CMS adoption is part of
P1.

## Exact schema and model closure

Proposed new files below are relative to `packages/docs-protocol-agent-teams/`. Existing schemas
total 337 lines (Cohort2 149 + profile3 68 + state2 120), so the data-only successor is plausible
within budget; this is an estimate, not a future measured diff.

| New artifact | Required content and references |
| --- | --- |
| `schemas/qualified-docs-cohort/v3.schema.json` | `$id` `https://agent-teams.ai/schemas/qualified-docs-cohort/v3`; closed `$defs/cohortCore` and `$defs/cohortBinding`; generation3, exact five coordinates, workflow/assets, explicit 4/3/1 tuple and runtime binding |
| `schemas/docs-consumer-integration-profile/v4.schema.json` | `$id` `https://agent-teams.ai/schemas/docs-consumer-integration-profile/v4`; schemaVersion4; preserve repository/root/pnpm/profile/skill/caller/state/qualification/governed-roots fields; Cohort ref only `.../qualified-docs-cohort/v3#/$defs/cohortBinding` |
| `schemas/docs-consumer-managed-state/v3.schema.json` | `$id` `https://agent-teams.ai/schemas/docs-consumer-managed-state/v3`; schemaVersion3; package/schema/runtime and authority projections exclusively from Cohort3; domain-separated state digest covers complete policy/lane/tuple/authority/assets |
| Managed runtime policy projection asset and schema | Proposed `assets/runtime-policy.v1.json` and `schemas/managed-runtime-policy/v1.schema.json`; schemaVersion1 projection is derived from canonical current-policy successor, binds source id/version/digest and exact two-lane table; no independent mutable authority |
| Sibling model/validator/projection | Explicit V3 Cohort binding, V4 profile, V3 state and closed runtime selection types; no widening of old Node24 aliases, no `any`/double-cast proofs; selected policy validation and deterministic state projection |
| Schema adapter/pack registration | Load every new local `$id` and `$ref` without remote resolution, register exact version, export the schema files and include packed refs; keep old entrypoints/dispatch unchanged |

Cohort3 retains generation2's immutable package/workflow/asset/edge data meanings, but does not
refer to the old runtime definition. Add a `candidateDigest` integrity binding at the new cohort
core and include it in state authority; candidate wire parsing/authentication remains G1/P7. In P1
it is strictly a nonzero SHA-256 field, not proof of central qualification. Do not admit an actual
record solely because this shape validates.

The runtime object is closed and has exactly:

- `policy: { id, version, digest }`, binding the packed projection's canonical policy authority;
- `selectedLane`, either `node-24-production-default` or `node-26-managed-qualified`;
- `node`, lane-specific `>=24.18.0 <25` or `>=26.0.0 <27`;
- `pnpm`, `>=11.17.0 <12` as capability range;
- `qualificationRuntime: { nodeVersion, pnpmVersion, platform, architecture }`, exact non-floating versions, platform and architecture from the closed projection;
- `runtimeClosure: { domain: "agent-teams.docs-runtime-closure/v2", digest }`.

Pure validation checks cross-field consistency, exact selected qualification tuple and policy
identity; matching enums independently is insufficient. Provisioned binary observation belongs to P2
and is passed as explicit data. The Node24 tuple is default and the Node26 managed tuple is
non-default. Exact initial fixture versions are 24.21.0/26.10.0 with pnpm11.20.0, with a separately
named actual platform/architecture. These are test bindings, not a claim that every old Node24
consumer uses that patch or every platform is qualified. A central record later names only tuples
actually qualified.

Preserve canonical coordinate order and exact names: Repository Mutation, Document Authoring, Docs
Protocol, Docs Protocol Agent Teams, Engineering Foundation. Root designation is only Docs Protocol,
managed adapter, Foundation. Strictly reject sixth coordinate/MCP, duplicate coordinate or roots
inferred from installed modules. No self/duplicate upgrade or rollback edge, and rollback origins
must match the admitted direction semantics. A data invariant can check a closed edge shape/subset;
checking actual prior QUALIFIED/support/enrollment requires G1 authority and is not claimed by P1.

Profile4 binding excludes transient lifecycle selection fields exactly as the historical profile
does. Full Cohort3 selection versus stored binding remains explicit. State3 projects the complete
approved binding, consumer identity and managed assets; digest uses
`agent-teams.docs-protocol.managed-state/v3` and one canonical byte algorithm, omitting only its own
stateDigest. Independent fixture oracles state expected bytes; do not generate expected and actual
with the same projector. Preserve every old domain and UTF-8/UTF-16 ordering choice of old receipts;
a new shared helper must not silently recanonicalize them.

No generation inference, no implicit migration, no runtime defaults from ambient process. Unknown
versions/keys, unsafe numbers, duplicate decoded JSON keys, noncanonical identity, missing
field/ref, invalid root and digest all fail closed. Bounded input limits and exact own-data shape
checks precede proportional work. A profile4 reader must not reuse the old profile3 runtime type and
cast away the mismatch.

## Policy-owner handshake without overwriting another worker

The current `architecture/foundation/docs-protocol-current-policy.json` is schema 1,
policy 1.0.0. P1a's managed-data lane owns the proposed canonical successor schema
at `architecture/contracts/docs-protocol-current-policy/v2.schema.json`, its
explicitly versioned data and the deterministic packed managed projection as one
closure. It must coordinate with the active portable/current-policy worker at the
integration head and preserve that worker's changes. Do not rewrite schema 1 or
historical policy bytes, invent the successor policy SemVer ahead of its actual
implementation, or hand-author a second lane authority. Bind the managed
projection to the canonical policy's exact version/digest, keep history entries,
and add protection for old managed profile3/state2/receipt3. No new public JSON
Schema family support claim follows from these artifacts.

The policy is a real P1a deliverable, not an externally supplied prerequisite or
another approval ceremony. Current `scripts/node-engine-compatibility.mjs`
reads `architecture/foundation/docs-protocol-current-policy.json` directly and
selects `productionDefault` and `compatibilityLane`. P1a must retain those
portable Node24/Node26 observations and their exact qualification behavior when
the canonical policy advances: either the integrated checker reads v2 with
explicit version validation, or a versioned selection keeps its v1 input exact.
A P1a acceptance invariant for both `contracts.profile` and
`contracts.portableCommandEnvelope`: the v2 schema and loader reject a `current`
generation absent from `supported`, or a `currentSchemaPath` other than the exact
schema path for that family and `current` generation. Mutation fixtures for each
family must reject both an omitted current generation and a mismatched path.
A passing managed projection test cannot substitute for this portable checker.
Coordinate that reader change with the active portable owner, without modifying
it in this docs-only lane. Synthetic policy data may support preparatory reader
tests, but production P1a closure requires the actual canonical successor,
reproducible projection and compatible current-policy reader. P1b then consumes
that closed P1a authority. No fake production digest may stand in for either
checkpoint.

## Suggested concrete internal operations

These names describe narrow proposed responsibilities; preserve existing naming conventions during
implementation.

1. `parseManagedSuccessorProfile(bytes, policy)` — adapter performs bounded strict parsing and AJV reference closure, then pure checks return a fully validated profile4 or bounded diagnostic. The policy is explicit, not read from environment. Error category distinguishes syntax/schema/version/tuple/policy mismatch.
2. `validateManagedRuntimeBinding(binding, policy, observedTuple?)` — pure consistent-lane/tuple validation; optional observation only compares facts already supplied by an adapter and cannot certify they were observed. Return a validated selection or refusal; never spawn to decide policy.
3. `projectManagedSuccessorState(profile, exactAssets)` — pure state3 projection/digest from validated inputs, same ordering on repeated runs; no file writes or workflow selection.
4. A private schema-loader entry compiles all successor files from the installed managed package. Existing CLI reader still refuses unsupported successor operational selection; tests invoke the sibling directly. Avoid registering profile4 into a dispatcher whose downstream compiler cannot consume it.

The package remains installable and its existing paths work unchanged. Future qualification can
consume the curated projection API when that consumer lands; do not create dead public runtime APIs
just to reserve names. Schema exports are themselves the finite contract being introduced, subject
to release-owned artifact treatment. Adding them does not publish them in this source checkpoint.

## Authored line allocation and stopping rule

| Slice | Budget (additions + deletions) |
| --- | ---: |
| Cohort/profile/state schemas, canonical policy v2 schema/data and projection schema | 620 |
| Explicit models, cross-field policy checks and state projection | 340 |
| Schema loading, policy generator/input binding, export/pack wiring | 220 |
| Positive/rejecting/runtime-type and historical regression tests | 580 |
| Feature/source/test manifests, docs and Changeset | 100 |
| Contingency | 40 |
| Original target total | 1,900 |

Count actual authored diff, including moved/deleted lines; no compressing tests into unreadable
lines or relabeling copied schemas generated. The combined P1a/P1b ceiling is 2,500. If the complete coherent slice
grows beyond this limit, first deliver only the closed Cohort3/canonical-policy-v2/managed-projection
schema/model/loader/pack+tests P1a sub-seam and then profile4/state3 with their complete
reader/projector/test closure in a separate checkpoint, as the original plan allowed. Do not leave
unresolved schema references, empty exported types or an operational path missing validation between
checkpoints. The full P1 completion condition remains all data closure delivered; report
intermediate scope accurately.

## Required independent verification

All fixtures below are local inert data unless explicitly effectful; effectful future tests get NEW
disposable roots only. Use existing managed-test owner directories and the exact test manifest; no
new generic testing framework.

| Positive oracle | Rejecting oracle |
| --- | --- |
| AJV2020 compiles complete successor refs from source and packed schema files | Missing/duplicate `$id`, wrong exported namespace, unresolved/remote `$ref`, new file absent from pack |
| Explicit 3/4/3 cohort/profile/state with exact 4/3/1 schema tuple and separately valid lanes | Every mixed old/new generation; profile3 selecting Cohort3; state2 holding Node26; lane26 paired with Node24 node range or tuple |
| Policy projection generated deterministically from exact canonical input; portable Node engine checker retains its exact Node24 default and Node26 compatibility observations under the selected policy version | Wrong policy id/version/digest, different lane table or default, v2 policy interpreted as v1, declared target version without exact qualified tuple |
| Exact five coordinates/three roots and known seven package edges | Sixth/MCP coordinate, extra root, swapped exact version/SRI, arbitrary dependency edge |
| Independently specified profile/state bytes and digest; repeated projection stable | Tampered candidate/record/event/policy/assets/runtime, stateDigest from old domain, caller-supplied digest treated as authority |
| Historical v1/v2/v3 reader outputs and schema byte digests remain exact | Node26 reinterpreted through old runtime definitions; unknown schema coerced to legacy; old receipt rewritten with new canonicalization |
| Closed strict JSON and bounded parse failures | Duplicate decoded keys at nested levels, unknown keys, malformed/zero digests, oversized values and unsafe numbers |
| Source policy accepts the new exact feature-owned files | Application imports Node/process/adapter, portable imports managed, qualification deep-import bypass or unadmitted primitive caller |
| New sibling data reader works while current CLI rejects unsupported operation | Installing schema export alone makes generation3 upgrade/finalize/restore selectable |

Run focused schema/model tests and pack-ref checks on the exact implementation head, then normal
`pnpm check:changed` during editing, `pnpm check:fast` at handoff and `pnpm verify` before PR.
Retain the actual commands, fixture identities, counts, tool versions and exits. Integrate new
source into unchanged production coverage; no directory exclusions, pending roots or weaker
thresholds. Do not rerun unrelated expensive checks on unchanged inputs just to manufacture new
timestamps. This proposal supplies no implementation test result.

## P1 completion audit and rollback

P1 is complete only when: all new refs resolve from packed bytes; every model/schema/guard tuple
agrees; real canonical policy input is bound; independent positive/rejecting and historical tests
pass; exports/feature/source/test manifests and coverage include new code; authored diff is measured
<=2,500 under the owner decision; existing operational dispatch remains unchanged; normal required gates pass at the actual
code head. These are future acceptance requirements, not evidence supplied by this review.

Before operational selection, revert the additive schema/model/projection/tests and their
registrations as one unit; no consumer has emitted these formats. After any later selected consumer
transition, rollback is the P0 proof-selected operation with retained executor/artifacts and fresh
authority, never uninstalling code that owns a recognized journal. Do not remove historical
controllers or rewrite published bytes when reverting source preparation.

## Decision dependencies and evidence boundaries

The observed current policy at `architecture/foundation/docs-protocol-current-policy.json`
is schema 1 with policy data 1.0.0. P1a owns the future canonical policy v2
schema/data and its deterministic managed projection. It cannot hand-author a
second lane table or overwrite concurrently integrated portable work. The
managed package consumes that exact canonical authority, while P1b waits for
the closed P1a data seam; independent schema and rejection-fixture preparation
alone does not establish that closure. The accepted [package
DAG](0043-new-only-portable-documentation-package-boundary.md)
still governs all imports. The semantic owner remains the local
[Feature Module Standard profile](../architecture/feature-module-standard.md),
not a new package-wide runtime service.

At release, derive the exact package publication order from the internal
dependencies in the manifests at the release head, as ADR-0043 requires. This
proposal maintains no separate order and does not turn a planned checkpoint
sequence into a release schedule.

The accepted [qualified runtime
decision](0032-qualified-runtime-and-source-owned-cohort-transitions.md)
requires source-owned executable evidence and complete dependency closure.
The [fix-forward admission decision](0034-fix-forward-stable-cohort-admission.md)
prevents embedding a future package's own SRI. The
[one-command decision](0037-one-command-qualified-cohort-upgrades.md)
requires compensation after failed activation. This proposal refines the
specific 2->3 path by binding an external exact successor controller and by
requiring either an authentic full replacement receipt for failure compensation
or an explicit recovery-required result. No central edge can equip an immutable
old source package with a new executor. A retained controller is a separately
qualified exact artifact, not a compatibility alias.

The [five-coordinate decision](0045-five-coordinate-qualified-docs-cohort.md)
and the old Cohort schemas remain exact. The proposed new lane has no sixth
managed coordinate. The [restoration proposal](0052-bounded-managed-v1-restoration.md)
remains proposed and governs only its own future acceptance path. The accepted
[JSON consumer admission](0053-restoration-strict-json-consumer-admission.md)
admits its one named strict reader, not a broad qualification caller. The
accepted [API dispositions](0054-hardening-public-api-dispositions.md) and
[metadata-root decision](0055-qualified-non-release-metadata-root.md) remain
untouched; neither grants runtime migration or release authority.

A central candidate schema is evidence of shape, not qualification. A
behavioral receipt is evidence of observed execution, not canary promotion.
An execution envelope binds source identity, install observation, runtime and
workflow, but does not authorize admission without central verification.
A QUALIFIED record/event authenticates enrollment at its own central authority
stage; it cannot be hashed into the candidate that precedes it. A canary
check-run proves its protected canary condition separately. Production
readiness additionally needs consumer-specific preparation and an explicit
release/cutover decision outside this proposal.

The proposed central schema/reader names are reservations grounded in the
supplied archive. On integration, compare the live protected authority and
active workflow guards before assigning paths or public versions. Preserve
all predecessor records, event bytes, exact digests, support windows and
rollback edges. An exact upstream archive and source revision make this
proposal reviewable but do not authenticate a future protected-main snapshot.
The next central implementer must bind the actual snapshot, source artifacts,
workflow blob/run and inverse with the existing authority-evolution procedure.

No part of this proposal permits changing Node 24 production default, weakening
`engine-strict` or `strict-peer-dependencies`, editing historical schema bytes,
reducing production source coverage, excluding tests from manifests, widening
suppression scope or manufacturing a release-owned baseline. Any selected
managed transition must have its exact source/target packed bytes, historical
controller and kernel, externally selected proof, real installed CLI results,
recoverable process/installation debt and fresh central authority. Those
conditions are mandatory even if a narrow P1 data check and fast gate pass.
