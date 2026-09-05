# Changelog

## 0.1.0

### Minor Changes

- [#224](https://github.com/agent-teams-ai/engineering-foundation/pull/224) [`4e22962`](https://github.com/agent-teams-ai/engineering-foundation/commit/4e229623ff555b655e7df24f9d1502ec5b968911) Thanks [@777genius](https://github.com/777genius)! - Extract the zero-monorepo-dependency Repository Mutation leaf, cut generic
  callers over to its new-only API, and remove the obsolete Foundation mutation
  facade.

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

## 0.0.0

- Establish the new-only Repository Mutation package boundary.
