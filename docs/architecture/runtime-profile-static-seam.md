# Runtime Profile Static Seam

Status: `not-adopted`; closed static selection only

This record classifies the additive Bun command-adapter checkpoint. It does not
adopt Get Modular Assembly, create an Assembly Host scope, or change any
historical ADR bytes.

## Authority delta reviewed

CMS guidance commit: `7131d0d7a6bb5dd4c3e8906ccac065c0be0e0333`

CMS guidance SHA-256: `a6dac5d303adf80be3151c6703c919b715fd880a941a4ad68e927c87a7ee5882`

The complete reviewed Consumer Module Standard input is Get Modular
`docs/architecture/common-assembly.md#consumer-module-standard`, blob
`dad8b6280cf999d9079d3106094e5626b63d83f4`. Its bytes match exact upstream
`main` at `eadd9d391657ae6f508a874dd30e923bdc4054f0`, observed on 2026-10-22;
the reviewed content pin remains `7131d0d7a6bb5dd4c3e8906ccac065c0be0e0333`.
The complete current document, provenance and delta from the previous
`300e7e1c459c08f5e271627e4ca7d2486bdf5e1f` input are retained as
[review evidence](evidence/doctor-guidance-20261022/README.md).
The previous reviewed commit `3dd68a6b26f42159714a4640b613534a55c2c6aa`, blob
`250f312d3cae733935d0ac48ddde8502665417df`, SHA-256
`e5cb510c5ea83e54a6833cc40b6ad31fc5cf8c70d9838e4e0c6923edc6f70919` remains
[historical evidence](evidence/runtime-profile-guidance-20261018/README.md).
Those bytes matched the process-runtime section 6 review at
`ccd815eac780b603a4cb6d01d07c995348c7b0f5`; this pin migration follows the
retained delta rather than a moving branch.

Historical CMS guidance: commit `7d6535dd86533566620040233290869825000d2b`,
blob `20c281b3137f5d3c198250e9f8101c0ecd4cbc75`, SHA-256
`859fbca1e8a0c61b6ae873bea0057735a55b80230100e6e73a74de22e123165a`.
The previously reviewed revision `5287ef4ebae3dce19feb9378a9a0ac9267b30878`
is byte-identical to that historical input. Another retained Foundation record uses modifying commit
`81063add7de50ffe2b91cc74bf7271b298624c21`, SHA-256
`49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7`.
The older `6b31f20...` QGR input remains historical evidence and is not rewritten.

EQS guidance commit: `f5653f5630057524a4ee44e50c16e138442a9b42`

EQS guidance SHA-256: `a65fb5150837b010a71abe36cefd26c32709eb9b9e89f3938498a647e72f5587`

These are Foundation's existing accepted organization Engineering Quality
Standard identities in `standards/engineering-quality-standard.provenance.json`.
Organization `main` at `a34ecc6bc9bb165771f3962dccd25970dd5c0d98` was checked
on 2026-10-20 and has identical EQS document bytes. The historical
`f9f4c8ad381254fb07cba737d6443542348395c1` and
`66d6d3d2c2643edac414ded48c0ee0586774dd07` inputs shared SHA-256
`d55f9f498da213dfa7b14aeac5df5b2fcf37b2cfed4c63dd88b51bde6f56ebe8`;
they no longer describe the current EQS pin.

### Reviewed delta and applicability

The earlier CMS delta replaced bound factory handles with module entries,
`implement`/`input`, static groups and `prepare({ modules })` (ADR-0036).
ADR-0037 pins providers, roots and non-completed rows in independent wiring
oracles. Module examples, layout checks, prototype-port rejection, codemods and
per-root smoke/wiring/namespace guidance now follow those forms. Static module
lists remain supported; being static alone is not a reason to reject Assembly.

The current delta adds observation communication rules and signal-bound
subscription detachment before cleanup, keeps resources in composition,
restricts observation testing imports to tests and requires subscription leak
checks. This seam introduces no observation store or subscription. Its existing
Host custody and cleanup contracts remain the applicable ownership mechanism.

The updated CMS and EQS describe FMS v1.1 sub-features and composition
contracts. Foundation's accepted `architecture/foundation/feature-modules.json`
still pins FMS v1 through ADR-0046; no v1.1 adoption or nesting is introduced.
The fixed-library/private-helper rule and Host cleanup ownership remain
unchanged. This seam has no Assembly entries, groups or independent module
lifetimes, so it requires no Assembly API migration and remains `not-adopted`.
Future qualifying boundaries follow the review trigger below using the current
entry/group and conformance guidance, not the historical handle examples.

`pnpm standards:check` authenticates the full retained CMS and EQS bytes,
provenance, reviewed CMS delta digest, current guidance fields and exact seam
paths. Both `check:fast` and `check` already run it. Its rejecting tests are
`tests/engineering-quality-standard.test.mts`. This checks the recorded
classification and guidance identities; it does not certify Assembly adoption.
Accepted ADR bytes and the existing FMS adoption profile remain unchanged.

## Closed seam

The exact outer seam is:

- `packages/engineering-foundation/src/process-execution/application/runtime-selection.ts`;
- `packages/engineering-foundation/src/capabilities/quality-gate-runner/composition/select-package-script-executor.ts`;
- `packages/engineering-foundation/src/capabilities/quality-gate-runner/composition/node-quality-gate-command.ts`;
- `packages/engineering-foundation/src/capabilities/repository-agent-workflow/composition/select-package-script-runner.ts`; and
- `packages/engineering-foundation/src/capabilities/repository-agent-workflow/composition/node-commands.ts`.

Owner: Engineering Foundation process execution for the minimal executable
selection policy; `quality.gate-runner` and `repository-agent-workflow` retain
their respective package-script contracts and concrete adapters.

Rationale: the seam selects one of two already named package managers after
policy validation. It has no registry, plugin API, generic service bag,
independently managed module instance, dynamic dependency graph or lifecycle
ownership.

The external process-library wiring is a second fixed adapter boundary at
`packages/engineering-foundation/src/process-execution/node-process-runner.ts`.
It imports the accepted technical adapter and supplies the existing Host-owned
`acquire`/`cleanup` custody pair. The exact helper
`packages/engineering-foundation/src/process-execution/node-runtime-verifier.ts`
is a newly added Foundation process adapter helper. It verifies admitted Node for
the Windows managed bootstrap and verifies the explicitly selected Node or Bun
executable identity for QGR and repository-agent-workflow. The existing
composition callbacks pass the explicit `node`/`bun` kind; the helper does not
select or detect runtime profiles. The QGR and workflow composition roots obtain
the verifier through the existing `process-execution/module.ts` entrypoint and
declare their dependency on `foundation.process-execution.composition`. The
process composition owns the concrete adapter dependency. The private helper
`packages/engineering-foundation/src/process-execution/windows-command-launch.ts`
checks the Host-owned STARTED/FAILED protocol before exposing a command as
launched; interruptions return to the generic executor for classification and
cleanup. These helpers belong to the existing
`foundation.process-execution` adapter roots. None is an independently assembled
module, uses lifecycle-kernel or introduces an Assembly node.

Review trigger: add a new independently assembled capability, make the selected
runtime graph configurable beyond these closed profiles, or give selected
objects independent lifecycle/resource ownership. Any of those requires an
exact Host scope through Core/Assembly before merge. Until then the status stays
`not-adopted`.

The independently implemented process library boundary remains outside this
runtime-profile seam. Functional managed-process delegation binds published
`node-or-bun@0.2.1` through the existing Host custody pair.
The root verified its signature and provenance and the registry archive SHA-256
`40e412afca40fe113485a2ae364251202967ad688f0282def5ea5294f8b98b70`; its library
main is `46f0a8d5c4914e96589c4356ea9be7861eb422a5`. The patch release repairs the
missing bounded output facet in 0.2.0 so Foundation preserves captured output
when reconstructing a late observed nonzero result. The existing published
package owns reusable process mechanism, while node-runtime-verifier is
Foundation-local executable identity verification; no additional reusable package or
abstraction is justified. Historical pins, this record's `not-adopted`/static
scope, the absence of Assembly and dynamic scope, and the separate Bun/default
delivery remain unchanged. The Bun/default profile seam above remains owned by
the separate runtime-profile delivery.

Foundation's error adapter settles cancelled managed runs by reproducing the
historical library settlement order from the runtime facts surface (plan v4
section 3.2). The existing limitation — an independently observed numeric
nonzero exit after termination settles as a self-standing result — is
documented here as an inherited Foundation heuristic, not library arbitration.

## Bun default repository profile

The repository Host selects the fixed `bun` default and explicit `node` rollback
from `architecture/foundation/repository-runtime.json`. `tools/dev.mts` owns
isolated source projections and install/build orchestration;
`tools/repository-command.mts` owns the closed script and tool tables;
`tools/executable-policy.mts` layers exact qualification versions over the
existing explicitly kinded process verifier. `tools/pnpm-command.mts` admits the
actual pinned manager, and `tools/release-profile.mts` owns Node-only package
operations and lock projection. These are repository policy and fixed adapters,
not independent Assembly entries or a new library runtime.

The full CMS input was migrated through the retained reviewed delta on
2026-10-20. The EQS input was compared to current upstream and remains
byte-identical to its existing pin. The current evidence, CRLF protection and
rejecting standards checker remain authoritative. Process execution continues to
use `node-or-bun@0.2.1`; no mechanism is duplicated by the repository profile.
Tests, raw coverage, TypeScript/native launchers, package qualification and
publication keep their explicit Node lanes. Native CI additionally invokes the
existing Bun transport fixture in the Linux producer, Windows test-b and Darwin
native jobs. Those invocations establish only the platform-specific guarantees
asserted by that fixture; Linux evidence does not substitute for native custody.

The repository workflow and workspace dependency declarations use policy v2
with explicit Bun managers. Dependency declarations retain the canonical
`pnpm-workspace.yaml` inventory and catalog authority. The clean Node projection
changes the root manager declaration and those two policy managers to pnpm.
Its closed nine-field evidence records the source digest and all three original
and derived file pairs' digests, and rejects policy drift before building or
running commands. Historical seven-field evidence is not current qualification.
This closed repository projection is Host policy; public parsers never read a
profile environment override. Both published v1 pnpm-only schemas remain unchanged.

## Repository workflow coverage seam

Workflow boundary: `existing-static-adapter`

Workflow owner: `engineering-foundation/repository-agent-workflow`

Workflow lifecycle: `Host custody and cleanup; no Assembly or lifecycle-kernel adoption`

The check-changed command and its input-custody and check-runner contracts extend
the existing repository-agent-workflow capability. The exact additional seam is:

- `packages/engineering-foundation/src/capabilities/repository-agent-workflow/adapters/inbound/cli/check-changed-command.ts`;
- `packages/engineering-foundation/src/capabilities/repository-agent-workflow/application/ports/check-changed.ts`;
- `packages/engineering-foundation/src/capabilities/repository-agent-workflow/adapters/outbound/filesystem/mutable-check-input-custody.ts`;
- `packages/engineering-foundation/src/capabilities/repository-agent-workflow/adapters/outbound/pnpm/mutable-pnpm-check-runner.ts`; and
- `packages/engineering-foundation/src/capabilities/repository-agent-workflow/adapters/outbound/pnpm/qualified-pnpm-check-runner.ts`.

The existing `composition/node-commands.ts` supplies fixed adapters through
consumer-owned ports. These additions create no independently assembled
capability, configurable module relationship or independent module lifetime.
They remain inside the existing owning feature and require no Assembly entry.
The Host owns input-closure enforcement, executable identity, output custody,
physical cleanup and recovery. A lease's release ends its custody contract;
it does not certify physical cleanup. The mutable CLI reports unverified
feedback and cannot claim qualified coverage from a successful command alone.

The reusable option is the existing Foundation coverage mechanism, approximately
200 lines of policy, model and port contracts, rather than a new package or a
consumer-local copy. Consumer development tooling depends on Foundation's public
CLI; Foundation owns coverage planning and observation contracts, while each
consumer Host retains its policy and custody. No production runtime dependency
or general cross-consumer Host runtime is introduced. The review trigger above
also applies to any future independently assembled workflow capability.

The private static Host command lexer belongs to the existing
`foundation.configuration-input.application` boundary. Workflow and quality
policies share only literal token and safe repository-path recognition; each
owns its operation, tool, mode and argument requirements. The declared source
edges and private entrypoint add no independently composed module or lifetime,
public npm export or runtime manager. The retained CMS pin was compared with
Get Modular `ddf1e0b0053f546f12ca70190b237b4f7e78d09d`: its guidance bytes are
identical. The later observation-drain input is reviewed in the current doctor
guidance record below.

## Stack Toolchain diagnostic adapter classification

Doctor boundary: `existing-static-adapter`

Doctor owner: `stack-toolchain/toolchain-execution`

Doctor lifecycle: `caller-owned process budget and cleanup; no Assembly adoption`

The private `packages/stack-toolchain/src/features/toolchain-execution/adapters/doctor.ts`
and physical executable-resolution helpers in
`packages/stack-toolchain/src/features/toolchain-execution/adapters/executables.ts`
remain inside the existing
ADR-0064 toolchain-execution adapter owner. They report installed and resolved
tool identity through the existing command/report contract; they add no module,
replaceable relationship, independent lifetime or public package root.
`packages/stack-toolchain/tests/doctor.test.ts` belongs to that feature's existing
test owner, strict project and canonical inventory. Stack Toolchain continues to
depend on node-or-bun for process execution. Host budgets, signals and physical
cleanup authority remain with the caller. This classification does not certify
the incoming implementation, registry artifact or final native qualification.

The full CMS input was reviewed against exact upstream
`eadd9d391657ae6f508a874dd30e923bdc4054f0` on 2026-10-22. Its complete bytes match
the reviewed `7131d0d7a6bb5dd4c3e8906ccac065c0be0e0333` input. The seven-line delta
from the previous `300e7e1c459c08f5e271627e4ca7d2486bdf5e1f` pin requires retained
observation load drain after escalation; this static diagnostic adapter owns no
observation loader or subscription. All previous accepted ADR and guidance
evidence bytes remain immutable. The scope remains `not-adopted`.
