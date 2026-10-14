# Runtime Profile Static Seam

Status: `not-adopted`; closed static selection only

This record classifies the additive Bun command-adapter checkpoint. It does not
adopt Get Modular Assembly, create an Assembly Host scope, or change any
historical ADR bytes.

## Authority delta reviewed

The complete current Consumer Module Standard input is Get Modular
`docs/architecture/common-assembly.md` at commit
`7d6535dd86533566620040233290869825000d2b`, SHA-256
`859fbca1e8a0c61b6ae873bea0057735a55b80230100e6e73a74de22e123165a`.
The prior `5287ef4ebae3dce19feb9378a9a0ac9267b30878` input has the same bytes;
that zero-byte revision delta is retained rather than rewritten as a semantic
change.
The latest retained Foundation record uses modifying commit
`81063add7de50ffe2b91cc74bf7271b298624c21`, SHA-256
`49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7`.
The reviewed delta completes profiles in `prepare` under ADR-0035, updates the
module examples, adds property-style contract lint and codemod guidance, adds
namespace tests and requires per-variant composition-root evidence. The older
`6b31f20...` QGR input remains historical evidence and is not rewritten.

The organization Feature Module Standard v1 remains the semantic ownership
authority. Foundation's organization Engineering Quality Standard is now bound
to `f9f4c8ad381254fb07cba737d6443542348395c1`; its bytes remain identical to
the historical `66d6d3d2c2643edac414ded48c0ee0586774dd07` pin and that history is
retained in the provenance record.
Installing packages or adding a closed TypeScript switch does not adopt CMS or
change release authority.

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

Review trigger: add a new independently assembled capability, make the selected
runtime graph configurable beyond these closed profiles, or give selected
objects independent lifecycle/resource ownership. Any of those requires an
exact Host scope through Core/Assembly before merge. Until then the status stays
`not-adopted`.

The independently implemented process library boundary is intentionally not
pinned or stubbed here. Current application code continues to depend on the
existing managed-process ports; only outer composition may later bind the
accepted library implementation.
