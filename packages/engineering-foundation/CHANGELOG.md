# @agent-teams/engineering-foundation

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
