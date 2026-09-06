# Changelog

## 0.2.0

### Minor Changes

- [`ec09d48`](https://github.com/agent-teams-ai/engineering-foundation/commit/ec09d482515efa2b4d25cd04b96853f4f031ce84) Thanks [@777genius](https://github.com/777genius)! - Restore the historical known-file Plan and Receipt schemas to their exact
  Foundation 0.21.0 bytes. Current callers must select the new
  `schemas/repository-mutation/known-file-transaction-{plan,receipt}/v1.schema.json`
  exports. Current wire version 1, protocol, digests, envelope version 6, and exact
  owner and kernel recovery bindings remain unchanged. Historical journals require
  their retained exact Foundation artifact or manual recovery; no bridge is added.

  This slice requires the coordinated Authoring, Foundation, and Managed schema
  reference closure before publication.

### Patch Changes

- [`5399afc`](https://github.com/agent-teams-ai/engineering-foundation/commit/5399afcb232210986bf8bd2c31683fc917eec7a4) Thanks [@777genius](https://github.com/777genius)! - Preserve released schema export paths and their published bytes alongside the
  current owner-specific schemas. Historical Foundation qualification uses its
  separate exact schema generation, without replacing the public Mutation or
  Authoring schema surface with older Foundation definitions.

## 0.1.1

### Patch Changes

- [#257](https://github.com/agent-teams-ai/engineering-foundation/pull/257) [`c99caa1`](https://github.com/agent-teams-ai/engineering-foundation/commit/c99caa1a785cfc7c876c79bf6934e228555e6afd) Thanks [@777genius](https://github.com/777genius)! - Publish a coordinated patch wave to obtain a new release provenance origin for managed Cohort qualification, preserving existing package behavior and exact internal dependency alignment.

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
