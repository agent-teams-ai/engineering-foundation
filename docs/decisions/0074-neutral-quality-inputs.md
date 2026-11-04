---
id: ADR-0074
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0074: Neutral Quality Inputs

Decision owner: Product owner. The repository architecture coordinator records
this bounded decision after two independent plan-review rounds covering
architecture/universality, execution/E2E and public contracts/compatibility.
Implementation review, native qualification and publication remain separate.

Date: 2026-11-04.

## Context and boundary

The core quality checker currently interprets FMS topology, an explicit exception
to architecture neutrality recorded in ADR-0062 and the capability reference.
It independently reads configuration for static validation and tool preparation.
A real public built CLI probe validated a protected lint config, then used a
changed profile to execute a weaker config and returned success for the same
floating-Promise source. Matching tool selection counts did not prevent this.

The owner authorized a substantial, scoped refactor with portable library use,
strict affected tooling, installed E2E and repeated criticism. The
[reviewed plan](../research/quality-inputs-refactor-2026-11-04.md) defines the
implementation boundary and rejects a generic observation, transaction or
process-supervisor framework.

## Decision

1. Introduce quality profile v5 with neutral `topologyPath`, the existing single
   `toolchainConfigPath` project authority and a bounded invocation `budgetMs`.
   The current runtime executes v5 only. Retain all exported v1–v4 schema bytes
   unchanged and provide an explicit migration error for old profiles.
2. Move flat/nested FMS mapping to a pure `./quality-topology` export of the
   existing opt-in Feature Module Standard package. It has no Node or package
   imports. Core consumes only technical facts and never imports that package,
   including for types. Schema conformance qualifies the shared wire shape.
3. Normalize quality inputs once per invocation and pass those facts to tool
   preparation. Bind bytes actually decoded by the existing owners; re-enumerate
   and verify consumer-owned files before execution and successful completion.
   Keep the static path free of a process port and the shared findings producer's
   current execution behavior unchanged.
4. Use the existing full-input census plus explicitly consumed files and the
   protected installed lint closure. Re-resolve installed preset bindings.
   Persistent path-set/byte changes reject; identical-byte regular replacement
   is allowed. Installed dependency-tree stability remains a prerequisite, not
   an attested property. Full compiler dependency attestation, inode custody,
   hermetic execution and ABA protection are outside this contract.
5. Keep bounded discovery/read work and a shared cooperative deadline. Do not
   reset timeouts per tool batch, introduce global caches, or expand native
   execution authority. Existing classification, protected rules, native/assets,
   bridge admission and process custody retain their owners.
   The existing Repository Mutation retired-temporary observer accepts an
   optional read-accounting/deadline argument on its existing `./node` surface.
   It retains the physical reader, its 2 MiB per-file cap and identity checks;
   quality supplies its invocation budget. This closes an observed route around
   cumulative read limits without creating another filesystem observer or
   shared framework. Calls without the optional argument retain their behavior.
6. Support optional data-only derivation hashes so generated neutral topology
   rejects stale source bytes. This repository derives its own projection from
   its FMS and quality profiles and checks it on a required route. Core never
   executes a generator or interprets its architecture.

This decision supersedes only ADR-0067's commitment to execute legacy quality
profiles after upgrading to the next Foundation major. It closes the named
ADR-0062 core exception; the rest of both accepted decisions and their exact
historical payloads remain unchanged. The frontmatter does not supersede either
whole decision because their other package and artifact decisions still apply.

## Compatibility and qualification

Stopping execution of v1–v4 requires a Foundation major Changeset. The opt-in
mapper receives its own FMS release intent and any Foundation peer expansion
requires installed `./node` evidence. An intentional breaking artifact approval,
if reported by the ordinary comparator, must reference its actual exact
fingerprint; this decision does not approve an invented or blanket fingerprint.
Normal accepted-decision and release-owned API baseline promotion remain the
only promotion paths. The closed native compiler transition is unchanged.

Acceptance requires preserved classification/policy cases, installed neutral
root and monorepo consumers with real Stack/TypeScript/Oxlint, corrected
counterparts, deterministic installed drift rejection, FMS projection conformance,
real repository dogfood, strict affected test inventories and the complete native
matrix. Independent implementation reviewers must approve the final source.

The separate Repository Mutation owned-Plan fix in the same delivery retains
its public wire/digest/journal contracts and shares no snapshot framework with
quality coverage. The optional accounting argument above is the only additional
Mutation API change admitted by this decision. Although existing callers remain
valid, the compatibility policy conservatively classifies the changed function
signature as breaking: it needs a minor Changeset while the package is below
1.0 and approval of the exact fingerprint reported by the ordinary comparator.

The ordinary built comparator reported Mutation fingerprint
`sha256:e5e9917d9ec26bbee64bd39b3c58bb3bef94d2698de24a7f2aee0823c9d814ad`
for that changed observer signature and its named accounting interface on
`./node`. This decision approves that exact change. Released API and schema
baseline bytes remain unchanged; the release-owned workflow promotes them.
