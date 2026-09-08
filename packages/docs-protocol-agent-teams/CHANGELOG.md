# Changelog

## 0.2.2

### Patch Changes

- [#274](https://github.com/agent-teams-ai/engineering-foundation/pull/274) [`17f0fc5`](https://github.com/agent-teams-ai/engineering-foundation/commit/17f0fc5b34519616c95d7b2223ec8547016b18f1) Thanks [@777genius](https://github.com/777genius)! - Reject aliased consumer root paths during restoration and selected finalization before mutation by validating the original caller path against the retained consumer binding.

- [#274](https://github.com/agent-teams-ai/engineering-foundation/pull/274) [`17f0fc5`](https://github.com/agent-teams-ai/engineering-foundation/commit/17f0fc5b34519616c95d7b2223ec8547016b18f1) Thanks [@777genius](https://github.com/777genius)! - Validate managed consumer and restoration lockfiles without requiring their registry dependency closure to equal the isolated qualification graph. Preserve exact managed coordinates, integrity, root roles, internal edges and restoration ownership checks.

  Require every reachable tarball, including optional dependencies, to resolve from the npm registry before accepting a differing consumer graph.

- [#275](https://github.com/agent-teams-ai/engineering-foundation/pull/275) [`c8b9c18`](https://github.com/agent-teams-ai/engineering-foundation/commit/c8b9c1875b94d65f5e4aa59b569893eda2279f13) Thanks [@777genius](https://github.com/777genius)! - Remove restoration age gates that rejected otherwise authorized Cohorts with future eligibleAfter timestamps. Restorable prepare, finalize, and restore now follow the informational eligibility policy while preserving authority and support-expiry checks.

## 0.2.1

### Patch Changes

- [#272](https://github.com/agent-teams-ai/engineering-foundation/pull/272) [`49a95e8`](https://github.com/agent-teams-ai/engineering-foundation/commit/49a95e8075ec8e552e6a35c2955d36c5f0b6b930) Thanks [@777genius](https://github.com/777genius)! - Accept the central authority's optional closed publication reconciliation provenance while preserving original publication fields and full record digest validation.

## 0.2.0

### Minor Changes

- [#260](https://github.com/agent-teams-ai/engineering-foundation/pull/260) [`1637266`](https://github.com/agent-teams-ai/engineering-foundation/commit/1637266f6485d72492b1c7131d81100a6020ad87) Thanks [@777genius](https://github.com/777genius)! - Add an explicit, data-only projection from portable profile v3 to v4 while preserving managed profile, Cohort, state and qualification generations. Validate command execution receipts through new owner-qualified schemas and the exported Mutation receipt schema, preserving historical schema bytes.

  Bound authority response streaming even when Content-Length is missing or incorrect. Preserve byte-proved source permissions when staging a disposable consumer upgrade, independently of Git archive settings and extraction umask.

  Separate managed use cases, inbound commands, qualification adapters and composition. Select the concrete Mutation implementation in composition and keep its observations behind the managed application port.

### Patch Changes

- [#260](https://github.com/agent-teams-ai/engineering-foundation/pull/260) [`1637266`](https://github.com/agent-teams-ai/engineering-foundation/commit/1637266f6485d72492b1c7131d81100a6020ad87) Thanks [@777genius](https://github.com/777genius)! - Read process environment and time through explicit Node boundaries. Use one
  observed instant for both restoration authority bindings, reject invalid clock
  observations, and retain the offline Corepack network restriction.

- [#260](https://github.com/agent-teams-ai/engineering-foundation/pull/260) [`1637266`](https://github.com/agent-teams-ai/engineering-foundation/commit/1637266f6485d72492b1c7131d81100a6020ad87) Thanks [@777genius](https://github.com/777genius)! - Preserve released schema export paths and their published bytes alongside the
  current owner-specific schemas. Historical Foundation qualification uses its
  separate exact schema generation, without replacing the public Mutation or
  Authoring schema surface with older Foundation definitions.
- Updated dependencies [[`1637266`](https://github.com/agent-teams-ai/engineering-foundation/commit/1637266f6485d72492b1c7131d81100a6020ad87), [`1637266`](https://github.com/agent-teams-ai/engineering-foundation/commit/1637266f6485d72492b1c7131d81100a6020ad87), [`1637266`](https://github.com/agent-teams-ai/engineering-foundation/commit/1637266f6485d72492b1c7131d81100a6020ad87), [`1637266`](https://github.com/agent-teams-ai/engineering-foundation/commit/1637266f6485d72492b1c7131d81100a6020ad87), [`1637266`](https://github.com/agent-teams-ai/engineering-foundation/commit/1637266f6485d72492b1c7131d81100a6020ad87)]:
  - @agent-teams/docs-protocol@0.6.0
  - @agent-teams/repository-mutation@0.2.0

## 0.1.2

### Patch Changes

- [#267](https://github.com/agent-teams-ai/engineering-foundation/pull/267) [`ef8f60f`](https://github.com/agent-teams-ai/engineering-foundation/commit/ef8f60f8f077df761af463be6e88fa42fb26bbc6) Thanks [@777genius](https://github.com/777genius)! - Match the accepted Cohort V2 runtime closure digest contract, including its five
  coordinates, seven managed edges and complete raw peer and optional dependency
  graph. Preserve historical V1 serialization and Node type peer normalization.
- Updated dependencies [[`174bcf9`](https://github.com/agent-teams-ai/engineering-foundation/commit/174bcf991592715c0e5f205d6a707bc10ec198db), [`976e596`](https://github.com/agent-teams-ai/engineering-foundation/commit/976e596206b02608ef91e39521a477a7dd3702e2)]:
  - @agent-teams/repository-mutation@0.1.2
  - @agent-teams/docs-protocol@0.5.2

## 0.1.1

### Patch Changes

- [#257](https://github.com/agent-teams-ai/engineering-foundation/pull/257) [`c99caa1`](https://github.com/agent-teams-ai/engineering-foundation/commit/c99caa1a785cfc7c876c79bf6934e228555e6afd) Thanks [@777genius](https://github.com/777genius)! - Publish a coordinated patch wave to obtain a new release provenance origin for managed Cohort qualification, preserving existing package behavior and exact internal dependency alignment.

- [#259](https://github.com/agent-teams-ai/engineering-foundation/pull/259) [`0ef7151`](https://github.com/agent-teams-ai/engineering-foundation/commit/0ef71513c81ac45a889426fe62db074ba39194b1) Thanks [@777genius](https://github.com/777genius)! - Add explicit, bounded post-success restoration of a managed V2 consumer to its recorded V1 bytes, modes and historical installation. Retain successful migration proof, require fresh qualified rollback authority and exact controller/kernel identities, and use the existing CAS transaction and explicit historical activation recovery.

  Require independently selected preparation before publication, support explicit finalization retry after write failure or process death, and validate managed effects independently before restoration. Preserve optional local GitHub assertions and strict CLI result contracts.

- Updated dependencies [[`c99caa1`](https://github.com/agent-teams-ai/engineering-foundation/commit/c99caa1a785cfc7c876c79bf6934e228555e6afd)]:
  - @agent-teams/repository-mutation@0.1.1
  - @agent-teams/docs-protocol@0.5.1

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
