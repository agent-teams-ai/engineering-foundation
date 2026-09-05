# Changelog

## 0.1.0

### Minor Changes

- [#232](https://github.com/agent-teams-ai/engineering-foundation/pull/232) [`e486355`](https://github.com/agent-teams-ai/engineering-foundation/commit/e4863550a0e44769987a98a9f98fa6ccc9b1d014) Thanks [@777genius](https://github.com/777genius)! - Extract portable document authoring into its own package, remove the obsolete
  Engineering Foundation authoring exports and CLI, and rewire Docs Protocol to
  the new-only dependency graph without a compatibility facade.

### Patch Changes

- [#245](https://github.com/agent-teams-ai/engineering-foundation/pull/245) [`14ff06f`](https://github.com/agent-teams-ai/engineering-foundation/commit/14ff06fd984c33106b5322d672bc1e0af2bbc9f8) Thanks [@777genius](https://github.com/777genius)! - Bundle the private Markdown parser adapter when preparing published packages, reducing installation dependencies without replacing the maintained parser or changing public types. Authenticate bundled code against original lockfile archives and retain upstream notices, a CycloneDX SBOM, and reproducible build evidence. Source dependencies remain explicit; clean pack, registry qualification, release, and package checks use the same disposable distribution projection.

- [#230](https://github.com/agent-teams-ai/engineering-foundation/pull/230) [`8c6a252`](https://github.com/agent-teams-ai/engineering-foundation/commit/8c6a252fe36d868bd3757a370b60775ecdafd185) Thanks [@777genius](https://github.com/777genius)! - Compose the document-authoring and scaffolding journal stores over one shared
  journal slot store in Repository Mutation's Node-only mechanism surface. Both owners
  keep their released on-disk names, byte formats, fault phases, crash residue,
  and error wording; only the duplicated candidate, quarantine, retirement, and
  reconciliation mechanics now live in one implementation. The retired
  pretty-printed scaffold journal writer is removed; reading the historical format
  is unchanged.

  Two deliberate hardenings come with the shared store. A journal file that
  disappears during a proof now reports the owner's "changed" diagnostic instead
  of a raw `ENOENT`. Document authoring now re-proves its candidate immediately
  before hard-linking it into the canonical slot and refuses to report a removal
  as complete when the canonical slot was recreated concurrently, matching what
  scaffolding already guaranteed. Both owners now validate the journal before
  probing slot occupancy, so an invalid journal aimed at an occupied slot reports
  the contract error first.

- Updated dependencies [[`4e22962`](https://github.com/agent-teams-ai/engineering-foundation/commit/4e229623ff555b655e7df24f9d1502ec5b968911), [`8c6a252`](https://github.com/agent-teams-ai/engineering-foundation/commit/8c6a252fe36d868bd3757a370b60775ecdafd185)]:
  - @agent-teams/repository-mutation@0.1.0

## 0.0.0

- Establish the new-only portable Document Authoring package boundary.
