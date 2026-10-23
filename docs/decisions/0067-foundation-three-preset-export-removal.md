---
id: ADR-0067
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0067: Foundation 3 Preset Export Removal

Decision owner: Product owner. Accepted by the repository architecture
coordinator after independent review within the owner-authorized Foundation 3
delivery. Exact artifact observation, unchanged typed API and seven rejecting
probes confirmed this bounded approval.

Date: 2026-10-23

## Context

ADR-0064 assigns executable pins and technical presets to the independently
published Stack Toolchain. Foundation 3 implements the authorized consumer
migration: governance and quality scope remain in Foundation, while consumers
select an exact published Stack development dependency for tools and presets.

The reviewed Foundation 3 source starts at
`a0b8894e11bcc88ad6ab774a65d77ef6e49f66f9`. The source manifest remains `2.1.2`;
the existing `foundation-toolchain-owner` major Changeset prepares Foundation 3.
Removing Foundation's public `./presets/*` wildcard is an intentional breaking
artifact change. The removed concrete members are:

- `presets/oxlint/base.json`
- `presets/oxlint/maintainability-tests.json`
- `presets/oxlint/maintainability.json`
- `presets/oxlint/node.json`
- `presets/oxlint/type-aware.json`
- `presets/typescript/base.json`
- `presets/typescript/node.json`

The same candidate adds `schemas/quality-source-coverage/v4.schema.json` under
the retained `./schemas/*` wildcard. The existing compatibility comparator binds
the complete artifact change, including that addition, to exactly
`sha256:5deff3b19edcdf86f219f5f9e23b15372386bfb3e238ea74bc2d375596f036f6`.
The ordinary native CI report correctly rejected this fingerprint because the
package policy did not yet reference an accepted exact approval.

The historical API Extractor-to-native-compiler transition is a different,
closed migration. Its driver correctly refuses this ordinary breaking change;
the failure does not authorize expanding that transition or rewriting released
baselines.

## Decision

1. Approve only the fingerprint above for
   `@agent-teams/engineering-foundation`, through `approvedBreakingChanges`
   referencing ADR-0067 through normal decision-baseline promotion.
2. Retain the existing major Changeset. Do not restore duplicate Foundation
   presets or introduce compatibility exports to avoid the intended break.
3. Preserve the released typed and artifact baselines, compatibility comparator
   and exact historical native-migration authority unchanged. The normal
   version workflow remains the sole public API baseline promotion owner.
4. Keep final native CI, packed consumers, public registry qualification and the
   separate required formatting phase as independent delivery requirements.
   An exact breaking-change approval is not evidence that those gates passed.

## Migration and evidence

Consumers move their TypeScript and Oxlint preset references from Foundation to
the matching Stack exports, add an exact published `stack-toolchain` development
dependency and regenerate their canonical package-manager lock. Existing
quality profiles v1-v3 retain their compiler project declarations while using
installed Stack tools; v4 selects `toolchainConfigPath` as its single project
authority. The full mapping, qualification and coordinated rollback are in
[the toolchain adoption guide](../development/toolchain-adoption.md).

The retained native CI run `39956844277` reports the exact fingerprint above.
The bounded source review retains the actual candidate artifact observation and
approval-rejection probes separately from ordinary full CI. This accepted ADR
satisfies approval only after promotion through the existing governance command;
final CI and release qualification remain required.
