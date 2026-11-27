# SDK engineering: three development profiles

Status: proposed owner-directed delivery plan, 2026-11-28. This is a
development-tooling workstream in Engineering Foundation, not a product
SDK runtime, new protocol, package admission, or release. The owner wants
all three profiles designed now and implemented in useful bounded stages,
in parallel with the separate Sync Foundation workstream.

## 1. Why and what already exists

[ADR-0061](../decisions/0061-library-first-foundation-boundary-evolution.md)
allows library-first implementation here when reuse is expected; two
existing consumers are not a prerequisite. Qualify new mechanisms using
disposable projects and at least one real consumer; remove superseded
consumer implementations during adoption. Use the
[ownership boundary](../architecture/ownership.md), FMS adoption,
existing source/quality gates, and accepted package dependency graph.
No consumer-specific policy or production dependency on Foundation.

The current repository already supplies:
- [Node TypeScript library boundary](../reference/node-typescript-library-boundary.md):
  source-bound scaffold plan/apply/recover for a private ESM package envelope.
- [Public API compatibility](../architecture/public-api-compatibility.md):
  native TypeScript 7 declaration inspection and release-owned baseline.
  The SDK Growth C0/S2/S3 routes are existing API/topology/authority
  mechanisms; do not rename or extend them merely because the word SDK
  appears here.
- [Protobuf evolution](../architecture/executable-capabilities.md#contract-evolution)
  and explicit `protobuf-qualify-breaking`: actual pinned Buf FILE
  comparison, candidate descriptor and versioned evidence. Normal check
  validates evidence and must remain process-free. Preserve the current
  configuration/evidence schema and accepted ADR-0019 boundary.
- [Quality gate runner](../reference/quality-gate-runner.md): execution
  of existing named scripts and closed dependencies. Do not introduce
  another DAG/task runner or free-form shell.
- Existing release checks, package/registry qualification, source coverage,
  repository mutation and scaffolding. Respect their actual public entry
  points, admitted scopes and package graph. Stack owns tool resolution
  and exact compiler/tool versions; product hosts own their native locks.

Source observations at Foundation main
`4d61a25f867d617ec035535cb3fee3153de6071c`:
`scripts/buf-qualification-e2e.mjs` invokes real Buf for descriptor and
breaking qualification, but its generated output digests are fixture
strings, not actual SDK generation. The existing capability compares
declared generation-drift facts; it does not by itself produce proof
of a fresh generation of clients. Keep those observations distinct.

First real service adopter: [Identity #2](https://github.com/agent-teams-ai/identity/pull/2)
at observed candidate
`273779ac25a9ff3f9a90b6b8214d29ffe02785ce`.
It has actual `tools/contract-generation.ts`, `generate-contracts.ts`,
`check-contracts.ts`, a local Buf v2 generator configuration and TS/Go
bindings. The repeated mechanism is tool verification, isolated generation,
generated output inventory/byte comparison and unchanged-input observation.
The owner-specific suppression-banner normalization, paths, schema, Go
module and mandatory native semantic vectors stay with Identity.
Do not edit that in-flight branch in this workstream. Orchestrator
[ADR-0015](https://github.com/agent-teams-ai/agent-teams-orchestrator/blob/main/docs/decisions/0015-handwritten-capability-sdk-over-internal-transports.md)
and [ADR-0016](https://github.com/agent-teams-ai/agent-teams-orchestrator/blob/main/docs/decisions/0016-protobuf-buf-connect-control-api.md)
already select handwritten capability facades above generated Protobuf/Connect.
[Payments SDK](https://github.com/agent-teams-ai/payments-sdk) is an
embedded library with real package/release and optional adapter boundaries.
[Organization offline-first proposal #475](https://github.com/agent-teams-ai/.github/pull/475)
describes another intended embedded consumer, not an implemented SDK.

## 2. Three independent profiles, one ergonomic workflow

| Profile | Input owned by consumer | Existing mechanisms to use | First useful proof |
| --- | --- | --- | --- |
| E: embedded library | Authored API, declarations, package/adapters | Scaffold envelope where applicable, strict compiler, existing public API/exports/pack/release checks | Real TS library with optional isolated adapter; built archive installed and exercised externally |
| S: service | Canonical Protobuf or existing OpenAPI, generator config | Buf/Connect, existing breaking qualifier, native generator plugins, real regeneration/drift and cross-language vectors | TS + Go clients against one real local service |
| N: native component | Actual implemented native library and its interface | Candidate Rust + UniFFI for foreign bindings; WIT/Wasm only for a different selected component profile | One real Rust component, Python binding, actual in-process call without network |

This is a common authoring/checking workflow, not a common business API
or runtime SDK. The consumer selects one or several profiles independently.
An embedded SDK is authored code, not generated business logic; a network
SDK does not run its service offline; native bindings do not turn TypeScript
into Rust or provide native storage automatically. No product needs to install
Buf, Rust, Python or a generator to consume a qualified ordinary TS package.
No global SDK service, generated client registry, mandatory cloud, proprietary
generator, universal IDL, universal error model, API translator, or copied
vendor engine. No output for unsupported languages until actual target proof.

Default developer route (consumer script convention, not new EF commands):
`sdk:generate` when generation actually applies, `sdk:check` to run the
selected native checks, existing build/pack/release commands for delivery.
Use the existing quality gate runner for a real multi-script profile.
For E there may be no generation step: the author writes a narrow facade
and the ordinary build emits declarations. Do not add an empty successful
generation script for symmetry.

The proposed profile inventory is documentation and consumer-owned native
configuration first. No new Foundation-owned configuration schema or
package node until concrete shared semantics need it. No generic command
list accepting arbitrary executable arguments from untrusted config.
Generators and their plugin configuration are executable trust inputs:
run only in explicitly selected reviewed tool/CI boundaries, not ordinary
Foundation static check or candidate-controlled protected promotion.

## 3. P0 — preparation and source contracts

- Inventory exact current public entries and their actual input/qualification
  contracts. Read latest eligible releases via the owning Stack/Catalog
  route; pin exact version + artifact/closure in selected fixtures.
  Foundation's current Buf 1.72.0 test and Identity's observed 1.75.0
  are different source-bound observations, not a reason to silently upgrade
  the existing qualifier. Follow the compatible selected channel.
- Existing FMS profile, strict TypeScript floor 7.0.2, complete native
  inventories, security:workflows, source/typed/format gates remain active.
  Use existing module composition only at actual composition seams.
  No runtime GM/LMU requirement for a static tool or pure comparator;
  no new lifecycle implementation.
- Decide if the current process, bounded source-inventory and artifact
  mechanisms are sufficient for the regeneration operation. Extend at an
  existing owner seam; do not deep-import a sibling package or create a
  new public export before examining its baseline/admission implications.
- Choose a named real adopter per newly shared mechanism. Identity is
  the first service candidate; use a reviewed exact fixture/consumer
  version, not a floating branch. Payments or a new actual embedded
  consumer can prove E. The native workstream needs a concrete consumer
  and selected native contract before claiming a supported release.

Exit: one scoped proposed owner record, exact planned qualification
subjects, no inferred success. Start S first; prepare E by using existing
mechanisms immediately; independently prototype N after native tooling
is available. They do not block one another or Sync Foundation.

## 4. S1 — actual service SDK generation and drift

The smallest missing reusable operation is a read-only observation of
generated output, not a new Protobuf compatibility checker.

Inputs: explicit consumer-owned contract root, reviewed local Buf module and
generation config, complete source inputs/import dependencies, exact resolved
generator/plugin executables and identities, exact generated output roots/
inventory and selected normalization policy (if required). Use existing
bounded source observation, process custody and exact argv APIs. Product
semantic test names and language-specific compilation remain consumer-owned.
Do not read secrets from config, evaluate consumer JS in the static checker,
silently fetch plugins/registries during the frozen run, or pass arbitrary
untrusted paths/args to a privileged executor.

Sequence:
1. Verify the selected tool family, versions, executable bytes/provenance
   under the existing trusted tool route. Capture declared input files,
   dependency locks, original output inventory and reviewed generator
   configuration. Require finite byte/file/time limits; reject path escape,
   symlink traversal or overlap with source/accepted baseline.
2. Stage only the reviewed complete inputs in an isolated temporary root
   with no credentials; use the native Buf local generation configuration.
   For S1 support the actually needed local module and local plugin form,
   not arbitrary remote plugins/templates or imports. Run lint/build as
   applicable and native generate. Reuse official protoc-gen-es,
   protoc-gen-go and protoc-gen-connect-go. The selected output roots
   must be generated-only, with product-owned files such as go.mod and
   facade code outside the compared generated leaf set. Do not use a
   destructive broad clean on a mixed source directory.
3. Compare complete relative output inventory and bytes/digests against
   independently observed committed generated files. Include missing,
   extra and changed leaves. No same-count or string-manifest shortcut.
   Check input and original output identity again before a positive result;
   an empty expected output is not accepted for a declared generating profile.
   Fail on unsupported generation form, timeout/cancellation, changed input,
   incomplete observation, or ambiguous output ownership.
4. Normalization is consumer-specific until an actual reusable rule is
   established. Identity's exact generator banner removal is reviewed and
   fail-closed; do not create a plugin system or permit arbitrary regex
   rewrites of generated content. S1 either stages the same explicitly
   trusted consumer normalization in its own native check or selects an
   unnormalized fixture with a separate Identity adoption discriminator.
5. Produce independently observed expected/actual digest and diagnostics
   suitable for existing `generationDrift` facts; do not overwrite or
   self-approve a release-owned baseline. Reuse
   `protobuf-qualify-breaking` and its exact evidence model for actual
   compatibility. Generation drift and wire breaking are independent.
   Normal Foundation capability check stays process-free.
6. In the actual adopting consumer, run native TS strict compilation,
   native Go tests, and real RPC with generated stubs. Preserve
   request identity, unknown enums/absence, large integers, typed errors
   and current authorization. Caller wait timeout is not server cancellation.
   Use the owning product's existing semantic vectors/IDL and facade.
   Remove replaced consumer-local shared verification only after parity.
7. S1 check mode never modifies tracked inputs/outputs. Use ordinary
   explicit native generate command for authoring. If a future Foundation
   write operation is needed, design a scoped reviewed Plan/Apply/recovery
   using existing mutation ownership; no partial in-place overwrite now.

Decide the smallest actual extraction after reading the fixture and
existing source mechanisms. Candidate placement is the existing Protobuf
qualification/tooling owner; not a new SDK-growth authority, generic
Foundation capability, independent package, or second process runner.
If existing owner commands and a small shared helper meet the need,
prefer that over a new CLI. Any new supported CLI/export must follow
actual public API/contract/version admission.

S1 E2E: two independent temporary generations using actual pinned plugins;
matching TS/Go files pass, tampered/missing/extra file rejects, changed
source during observation rejects, input remains unchanged, real service
client request in both languages returns the owner-expected result.
Reuse existing Buf positive/breaking qualification; do not duplicate it.
Identity adopter additionally proves its existing normalization and
native vectors; run on exact candidate bytes with installed package.
Generated artifacts excluded from authored LOC. No third language until
a real requirement.

## 5. E1 — embedded SDK

Use the current library recipe to create the smallest eligible envelope
when needed. Author actual contracts, facade and feature/adapter source in
consumer scope; no generator of DDD business logic or empty feature tree.
Keep ordinary entry free of optional platform and Foundation imports;
explicit optional adapters may use GM under actual CMS scope, LMU only
where the actual update profile is qualified.

Reuse existing native compiler, API baseline, export closure, package
audit, release candidate and registry qualification. Test actual packed
archive from independent external consumers, not a source alias.
Make example useful and runnable, check code/declaration resolution in
each claimed runtime, and assert the ordinary installation does not
transitively load unwanted optional adapter dependencies. Use existing
published compatibility mechanisms; no second SDK API diff.
No new mechanism by default. Add a small technical recipe or shared
check only for an uncovered real repeated operation, under its owner.

## 6. N1 — native language bindings

Candidate first spike: Rust library with one useful pure operation and
explicit typed error, UniFFI generation for Python, native dynamic
library + generated binding packaged into a clean local test install.
Use official [UniFFI](https://mozilla.github.io/uniffi-rs/latest/) tooling;
pin a compatible Rust toolchain/target and generator, Python interpreter
and artifact dependencies through the actual owner profile. Prefer
upstream build/bindgen commands; no own ABI, no Rust rewrite of TS libraries.

The implementation owner owns interface, ABI, native library, memory and
resource semantics. Test a real successful call and typed failure from
Python, native artifact load and exact expected behavior; if handles,
callbacks, concurrency or cancellation are exposed, test their actual
lifetime and bounds. An initial scalar/pure operation does not claim
those stronger capabilities. No network service or simulated FFI.
Check target architecture, packaging, platform, license and supported
runtime before distribution. Python first does not imply Swift/Kotlin
mobile binaries, Go, arbitrary ABI or cross-platform support.

WIT/Wasm Component Model is a separate alternative for selected portable
component execution, subject to existing EF/Runtime owner contracts and
actual Host evidence. Do not install both alternatives or define an
FFI abstraction before need. Rust/UniFFI is a candidate, not a mandatory
language for Foundation consumers. Reuse existing process/build/release
checks; no new generic native compiler manager. Any reusable addition
follows the same real-consumer parity rule. N1 may qualify a disposable
profile before a production adopter; release/activation remains separate.

## 7. Scope and sequence

| Work | Authored tool/production LOC | Authored test LOC | Complexity / target reliability / confidence |
| --- | ---: | ---: | --- |
| P0 design, owner review | 0 | 0 | 3 / 8 / 9 |
| S1 generation observation, shared helper/adopter parity | 150-400 | 150-350 | 6 / 8 / 6 |
| E1 existing library/pack/API route and runnable example | 0-150 | 100-250 | 4 / 8 / 7 |
| N1 one bounded native spike and real call | 100-300 | 100-250 | 6 / 8 / 5 |

These are initial allowances, excluding generated files, existing tools and
actual product implementation; not test quotas or proven reliability.
A generator failure or missing native owner prerequisite reduces the claim
rather than inviting a replacement engine. If no new shared code is needed
in E or N, zero production LOC is a success. Do not include OpenAPI
generation, additional languages, native platforms, commercial registry,
publication automation, generalized schema/FFI compiler, all-repository
migration, or new runtime dependencies in this first scope.
A future REST profile can reuse [OpenAPI Generator](https://openapi-generator.tech/)
or [Kiota](https://github.com/microsoft/kiota) against an existing REST
contract with an actual consumer, not a duplicated Protobuf IDL.

Use one related EF Draft PR, review each real increment, run complete native
checks on exact head and independent review before normal merge. Existing
repository instructions require changed/fast/security checks before source
handoff and the complete current-head/base full-ci for merge. Do not bypass
them if the local toolchain is unavailable. Merge, package publication and
consumer activation are separate. Use an exact packed TEST artifact for
adoption before npm if allowed by the owning scope.

Sync Foundation proceeds in parallel with E1: consumer owns its sync
contracts and PowerSync behavior, can use current Foundation library
recipe/checks, and does not wait for S1 or N1. It must not import
Engineering Foundation in runtime. Existing central admission and Stack
version proposals retain their own authorities and pending gates.
The shared SDK tooling must not become a new critical dependency for
ordinary feature construction.

## 8. Author review and execution state

- Reuse review: identified existing SDK-growth/public API, Buf, scaffolding,
  QGR and release owners; no duplicate framework, immutable schema edit or
  package-DAG change.
- Service source review: actual Identity local TS/Go generator and byte
  check establish first candidate. Existing Buf E2E uses synthetic
  generation digests; added actual generation evidence, complete inventory,
  read-only check and separate normalization/semantic gates.
- Trust/recovery review: generation is executable; use local trusted
  tools, bounded staging, no privileged candidate-config execution,
  exact output ownership and input reread; no auto promotion or mutation.
- Scope/ergonomics review: select three independent profiles, existing
  script conventions, first one service path plus existing embedded
  mechanisms; native spike stays separately qualified.
- Integration review: EF development-only, explicit real-consumer
  parity and packed evidence; independent Sync implementation need not
  wait for unused profiles.

This branch contains the proposed plan only. No new generator, real
generated artifacts, native call, source build, qualification, independent
review, release, product adoption or E2E success is claimed. Local native
toolchain/network access was unavailable at planning checkpoint; use a
proper provisioned checkout for P0/P1 source changes and actual tests.
