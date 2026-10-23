# Stack Toolchain

## 0.1.0

### Minor Changes

- [#437](https://github.com/agent-teams-ai/engineering-foundation/pull/437) [`b64506c`](https://github.com/agent-teams-ai/engineering-foundation/commit/b64506c4b2ed3d1f28e68934017ecba84ae09204) Thanks [@777genius](https://github.com/777genius)! - Report actual installed versions and availability for all six pinned tools through
  `doctor --json`, with stable findings for missing required tools and pin mismatches.
  Keep optional engine absence informational and resolve executable files within the
  consumer installation, including pnpm and Bun stores.

- [#430](https://github.com/agent-teams-ai/engineering-foundation/pull/430) [`24525ef`](https://github.com/agent-teams-ai/engineering-foundation/commit/24525efc78ab05a67851c3e888077cf8401cc5bf) Thanks [@777genius](https://github.com/777genius)! - Introduce a universal Node/Bun development toolchain with pinned tools, technical
  presets, sequential typecheck fallback and explicit output-producing compilation.

### Patch Changes

- [#435](https://github.com/agent-teams-ai/engineering-foundation/pull/435) [`67ccfb3`](https://github.com/agent-teams-ai/engineering-foundation/commit/67ccfb359fa2112e7a3554576391d4369477f937) Thanks [@777genius](https://github.com/777genius)! - Allow a separate syntax lint scope before the existing typed lint scope. Keep flat
  configurations unchanged, short-circuit syntax failures, and preserve named lane
  results under one cancellation signal and deadline.

- [#434](https://github.com/agent-teams-ai/engineering-foundation/pull/434) [`34a3d45`](https://github.com/agent-teams-ai/engineering-foundation/commit/34a3d453d98c9400c0231b65c109e7f00dca00d6) Thanks [@777genius](https://github.com/777genius)! - Treat missing optional Bun and tsrs native executables as unavailable while
  preserving mandatory compiler and corrupt-installation failures.

- [#438](https://github.com/agent-teams-ai/engineering-foundation/pull/438) [`02ba22a`](https://github.com/agent-teams-ai/engineering-foundation/commit/02ba22adc82117402bb471c9772daa97d4b757e2) Thanks [@777genius](https://github.com/777genius)! - Record the bootstrap-only release history so ordinary Changesets versioning preserves the changelog title and existing entries.

## 0.0.0

Bootstrap-only artifact; do not adopt. Use a supported release instead.
