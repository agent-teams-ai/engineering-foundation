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
`acquire`/`cleanup` custody pair. It is not an independently assembled module,
does not use lifecycle-kernel and introduces no Assembly node.

Review trigger: add a new independently assembled capability, make the selected
runtime graph configurable beyond these closed profiles, or give selected
objects independent lifecycle/resource ownership. Any of those requires an
exact Host scope through Core/Assembly before merge. Until then the status stays
`not-adopted`.

The independently implemented process library boundary remains outside this
runtime-profile seam. Functional managed-process delegation binds the accepted
library implementation through the existing Host custody pair, while an owned
TEST overlay supplies the unpublished archive for implementation proof. No
placeholder or unpublished registry pin is present; the supported coordinate
and lock/SRI/provenance remain publication gates. The Bun/default profile seam
above remains owned by the separate runtime-profile delivery.
