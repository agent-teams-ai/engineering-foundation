# @agent-teams/engineering-foundation

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
