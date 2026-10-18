# Runtime Profile Static Seam

Status: `not-adopted`; closed static selection only

This record classifies the additive Bun command-adapter checkpoint. It does not
adopt Get Modular Assembly, create an Assembly Host scope, or change any
historical ADR bytes.

## Authority delta reviewed

The complete current Consumer Module Standard input is Get Modular
`docs/architecture/common-assembly.md` at commit
`7d6535dd86533566620040233290869825000d2b`, blob
`20c281b3137f5d3c198250e9f8101c0ecd4cbc75`, SHA-256
`859fbca1e8a0c61b6ae873bea0057735a55b80230100e6e73a74de22e123165a`.
The previously reviewed retained revision
`5287ef4ebae3dce19feb9378a9a0ac9267b30878` is byte-identical to that input
and remains historical evidence. The latest retained Foundation record uses modifying commit
`81063add7de50ffe2b91cc74bf7271b298624c21`, SHA-256
`49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7`.
The reviewed delta completes profiles in `prepare` under ADR-0035, updates the
module examples, adds property-style contract lint and codemod guidance, adds
namespace tests and requires per-variant composition-root evidence. The older
`6b31f20...` QGR input remains historical evidence and is not rewritten.

The organization Feature Module Standard v1 remains the semantic ownership
authority. Foundation's current organization Engineering Quality Standard pin
is `f9f4c8ad381254fb07cba737d6443542348395c1`, SHA-256
`d55f9f498da213dfa7b14aeac5df5b2fcf37b2cfed4c63dd88b51bde6f56ebe8`.
The prior `66d6d3d2c2643edac414ded48c0ee0586774dd07` pin is byte-identical and
is retained as historical evidence in the current provenance record. This
checkpoint updates current guidance provenance without changing standard
content or accepted ADR bytes. Installing packages or adding a closed
TypeScript switch does not adopt CMS or change release authority.

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
is an existing Foundation process adapter helper: it verifies the admitted Node
executable environment for the Windows managed bootstrap and does not select
runtime profiles. Both files remain in the existing
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
Foundation-local environment verification; no additional reusable package or
abstraction is justified. Historical pins, this record's `not-adopted`/static
scope, the absence of Assembly and dynamic scope, and the separate Bun/default
delivery remain unchanged. The Bun/default profile seam above remains owned by
the separate runtime-profile delivery.

Foundation's error adapter settles cancelled managed runs by reproducing the
historical library settlement order from the runtime facts surface (plan v4
section 3.2). The existing limitation — an independently observed numeric
nonzero exit after termination settles as a self-standing result — is
documented here as an inherited Foundation heuristic, not library arbitration.
