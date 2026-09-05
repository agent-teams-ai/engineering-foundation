# Changelog

## 0.1.0

### Minor Changes

- [#242](https://github.com/agent-teams-ai/engineering-foundation/pull/242) [`132a9c9`](https://github.com/agent-teams-ai/engineering-foundation/commit/132a9c9deaf4d360f92718e2f6bfb65cb34ca967) Thanks [@777genius](https://github.com/777genius)! - Add Qualified Cohort v2 with five exact package coordinates, consumer
  integration profile v3, managed state v2, and qualification receipt v3. Keep
  only three consumer root package pins while qualifying Repository Mutation and
  Document Authoring as exact transitive coordinates.

- [#224](https://github.com/agent-teams-ai/engineering-foundation/pull/224) [`4e22962`](https://github.com/agent-teams-ai/engineering-foundation/commit/4e229623ff555b655e7df24f9d1502ec5b968911) Thanks [@777genius](https://github.com/777genius)! - Register the initial public API for the Agent Teams managed adapter and retain
  the portable Docs Protocol result type required by its current public API.

### Patch Changes

- [#243](https://github.com/agent-teams-ai/engineering-foundation/pull/243) [`fd8c4a1`](https://github.com/agent-teams-ai/engineering-foundation/commit/fd8c4a12fb4ca5ebddda4bc03afc9c84e40e4307) Thanks [@777genius](https://github.com/777genius)! - Accept the closed current Cohort v2 authority shape, fail closed on nested authority drift, and bundle stable10 as a supported immutable migration source.

- [#246](https://github.com/agent-teams-ai/engineering-foundation/pull/246) [`588a50d`](https://github.com/agent-teams-ai/engineering-foundation/commit/588a50d99fcb02dce5389407ebd5eba9d901b6b3) Thanks [@777genius](https://github.com/777genius)! - Make the managed authoring Skill compatible with portable adoption and bounded context at custom profile paths. Preserve historical Skill bytes and script digests, qualify the installed adapter Skill through the portable CLI, and accept the exact AGENTS route with Windows CRLF lines.

- [#232](https://github.com/agent-teams-ai/engineering-foundation/pull/232) [`e486355`](https://github.com/agent-teams-ai/engineering-foundation/commit/e4863550a0e44769987a98a9f98fa6ccc9b1d014) Thanks [@777genius](https://github.com/777genius)! - Extract portable document authoring into its own package, remove the obsolete
  Engineering Foundation authoring exports and CLI, and rewire Docs Protocol to
  the new-only dependency graph without a compatibility facade.

- [#243](https://github.com/agent-teams-ai/engineering-foundation/pull/243) [`fd8c4a1`](https://github.com/agent-teams-ai/engineering-foundation/commit/fd8c4a12fb4ca5ebddda4bc03afc9c84e40e4307) Thanks [@777genius](https://github.com/777genius)! - Accept validated historical consumer profile v2 bytes during direct migration to
  Cohort v2, preserving the existing schema normalization and new-only target.
  Verify failed-activation restoration through the explicitly recorded historical
  Docs CLI instead of requiring the new adapter in the restored dependency graph.
  Bundle the exact stable9.1 source assets and verify direct migration, failed
  activation restoration, and retry for all three active historical fleet cohorts.

- [#224](https://github.com/agent-teams-ai/engineering-foundation/pull/224) [`4e22962`](https://github.com/agent-teams-ai/engineering-foundation/commit/4e229623ff555b655e7df24f9d1502ec5b968911) Thanks [@777genius](https://github.com/777genius)! - Extract the zero-monorepo-dependency Repository Mutation leaf, cut generic
  callers over to its new-only API, and remove the obsolete Foundation mutation
  facade.
- Updated dependencies [[`4e22962`](https://github.com/agent-teams-ai/engineering-foundation/commit/4e229623ff555b655e7df24f9d1502ec5b968911), [`588a50d`](https://github.com/agent-teams-ai/engineering-foundation/commit/588a50d99fcb02dce5389407ebd5eba9d901b6b3), [`e486355`](https://github.com/agent-teams-ai/engineering-foundation/commit/e4863550a0e44769987a98a9f98fa6ccc9b1d014), [`4e22962`](https://github.com/agent-teams-ai/engineering-foundation/commit/4e229623ff555b655e7df24f9d1502ec5b968911), [`8c6a252`](https://github.com/agent-teams-ai/engineering-foundation/commit/8c6a252fe36d868bd3757a370b60775ecdafd185)]:
  - @agent-teams/docs-protocol@0.5.0
  - @agent-teams/repository-mutation@0.1.0

## 0.0.0

- Establish the new-only Agent Teams managed adapter boundary.
