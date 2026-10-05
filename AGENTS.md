# Agent Instructions

This repository owns reusable engineering tooling. It does not own any consuming
repository's business architecture.

Hard rules:

- never import this package from production runtime code;
- keep consumer-specific catalogs, bounded contexts, classifications, and ADRs in
  the consumer repository;
- follow the [extraction admission invariant](docs/architecture/executable-capabilities.md#extraction-admission-invariant)
  before moving consumer implementations into Foundation;
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
- before opening a pull request, run `pnpm check:changed`, `pnpm check:fast`,
  `pnpm security:workflows`, and focused checks for the changed behavior;
- before merging, require independent technical review and the complete
  successful explicitly requested `full-ci` matrix on the final PR head/base
  (`pnpm ci:full -- --pr N --wait`), including native qualification,
  complete inventories, and the adopted coverage authority. Reuse that evidence
  instead of also requiring a sequential local `pnpm verify`;
- treat `ci:full` and `ci:full:`-prefixed labels only as requests, never as
  qualification or trusted workflow-source authority. Feedback and full CI have
  separate concurrency groups; old snapshots may finish but cannot qualify a
  new head/base. Preserve the complete native matrix and strict aggregate union;
- reconcile uncertain label reservation/attachment effects through reads; never
  blindly retry writes. Use the user's authorized credential for a labeled
  request; `GITHUB_TOKEN` labeling suppresses that workflow event. Follow the
  [request and recovery contract](docs/development/quality-gates.md);
- use the reviewed pinned `ci:merge` operator path outside the candidate checkout,
  binding the actual protected hosted receipt and complete source tree to the
  final head/base/ref; do not substitute a caller-supplied review JSON;
- retain independent hosted technical review in PR comments; `ReviewGate` is
  retired and review must not become a self-attested Actions status. Before an
  owner squash, revalidate the current PR head/base, merge intent, complete native
  evidence and independent review, then use the canonical organization
  [`scripts/merge-owner-pr.mjs`](https://github.com/agent-teams-ai/.github/blob/main/scripts/merge-owner-pr.mjs)
  with `--expected-head`. Required-workflow authority is currently unavailable
  on GitHub Free; Actions integration `15368` alone does not authenticate
  workflow source. Keep this trust limitation explicit;
- keep `pnpm verify` as the full local diagnostic path when full CI cannot run
  or does not cover the changed risk; retain any uncovered check. Pending CI
  alone does not require a duplicate local full run. Never relabel evidence
  from an older SHA as current-head CI;
- a JSON Schema family support claim requires `contract.json-schema-releases`
  plus corpus and consumer evidence; exported schema bytes without that claim
  stay artifact-protected;
- schema mutation of a claimed family needs a new public contract version and a
  release-owned baseline, not edited old bytes;
- greening CI by shrinking governed scope, pending a root, or adding an
  unbounded suppression is forbidden.

Start with:

- [README.md](README.md)
- [Documentation index](docs/README.md)
- [Ownership](docs/architecture/ownership.md)
- [Executable capabilities](docs/architecture/executable-capabilities.md)
- [Quality gates](docs/development/quality-gates.md)
- [Local mode](docs/development/local-mode.md)
- [Release](docs/release.md)

<!-- agent-teams:quality-standard:start -->
Before planning, implementing, or reviewing changes, read and follow the
[organization Engineering Quality Standard](https://github.com/agent-teams-ai/.github/blob/main/docs/engineering-quality-standard.md).
Apply it with this repository's instructions, accepted decisions and local
adoption profiles. This reference does not change pinned architecture contracts
or certify existing code as conformant.
<!-- agent-teams:quality-standard:end -->
