# Agent Instructions

This repository owns reusable engineering tooling. It does not own any consuming
repository's business architecture.

Hard rules:

- never import this package from production runtime code;
- keep consumer-specific catalogs, bounded contexts, classifications, and ADRs in
  the consumer repository;
- do not extract a capability without parity fixtures and a consumer test;
- keep registry mode reproducible and local mode explicit;
- never commit local-link state or floating dependency ranges;
- do not select or introduce a user-facing documentation site generator,
  documentation portal, or visual documentation search UI without explicit
  product-owner approval; VitePress is only a possible future candidate, not an
  accepted decision;
- machine-readable documentation indexes used only by developer tooling or AI
  agents may be evaluated independently, but they remain rebuildable caches and
  never become documentation sources of truth;
- use conventional commits and short feature branches;
- run `pnpm check:changed` while editing and `pnpm check:fast` before handoff;
- run `pnpm verify` before opening a pull request.

Start with:

- [README.md](README.md)
- [Documentation index](docs/README.md)
- [Ownership](docs/architecture/ownership.md)
- [Executable capabilities](docs/architecture/executable-capabilities.md)
- [Quality gates](docs/development/quality-gates.md)
- [Local mode](docs/development/local-mode.md)
- [Release](docs/release.md)
