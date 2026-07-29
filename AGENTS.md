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
- use conventional commits and short feature branches;
- run `pnpm check` before opening a pull request.

Start with:

- [README.md](README.md)
- [Ownership](docs/architecture/ownership.md)
- [Local mode](docs/development/local-mode.md)
- [Release](docs/release.md)
