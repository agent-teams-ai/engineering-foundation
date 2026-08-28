---
id: ADR-0037
status: accepted
supersedes:
  - ADR-0031
superseded_by: []
---

# ADR-0037: One-Command Qualified Cohort Upgrades

Status: Accepted

Date: 2026-08-28

Decision owner: Product owner

## Context

ADR-0031 established the correct ownership split, but required maintainers to
project the central Cohort record, edit two package pins, and generate a
lockfile before the Docs Protocol compiler could run. That made a Cohort
upgrade a coordinated procedure instead of one reproducible operation and
duplicated projection knowledge across every consumer.

The existing offline `check`, `plan`, and reviewed `apply` lifecycle remains
useful for inspection and recovery. A separate explicit upgrade command can
own the network and package-manager boundary without weakening those contracts
or moving documentation authority out of the consumer.

## Decision

1. ADR-0031 decisions 1-3, 5, 7, and 8 remain in force. Its decisions 4, 6, 9,
   and 10 are refined by the explicit upgrade lifecycle below.
2. `agent-teams-docs consumer upgrade --to <cohort>` is the normal Cohort
   migration command. No integration-authority file edit, dependency-pin edit,
   or lockfile preparation is required before it runs.
3. The command resolves the current protected `agent-teams-ai/.github` main
   revision, reads the central Cohort registry at that exact SHA, and accepts
   only one selectable target with an explicit `upgrade_from` edge from the
   installed source. An optional revision must equal current protected main.
   `eligible_after` remains recorded evidence and is not a local time gate.
4. The source repository must be one clean Git HEAD, its current Cohort must
   pass `consumer check`, and the Foundation transaction barrier must be idle.
   Ambiguity or local edits fail before package installation or publication.
5. All preparation occurs in disposable Git-archive copies. The upgrade
   projects only the Cohort field in the managed integration profile, the two
   exact development-dependency pins, and existing pnpm release-age exclusions.
   pnpm alone generates the successor lockfile with lifecycle scripts and
   `.pnpmfile` hooks disabled.
6. The exact successor packages then run their own `plan`, `apply`, and `check`
   in the disposable copy. A closed inventory permits only the integration
   profile, manifest, lockfile, optional workspace policy, and already managed
   Docs Protocol assets.
7. Foundation's existing recoverable known-file transaction publishes the
   proven postimages once. Activation performs a frozen offline install and a
   read-only successor `check`; it is not a second writer.
8. If activation fails, the same Foundation protocol publishes exact reverse
   operations and the source package set is restored and checked offline.
   An interrupted Foundation transaction remains recovery-gated by its exact
   build identity.
9. `consumer check` and `consumer plan` remain offline and write-free. The
   reviewed `plan`/`apply` path remains supported for diagnosis and managed
   asset repair, but it does not replace the one-command Cohort migration.
10. Profiles other than the single Cohort projection, owners, schemas,
    templates, validators, governed documents, arbitrary manifest fields, and
    arbitrary workspace policy remain outside upgrade write authority.

## Consequences

- Cohort authority projection and lockfile preparation are implemented once
  instead of copied into each consumer rollout.
- Network and package-manager effects are confined to one explicit command and
  proved in a disposable repository before any consumer byte changes.
- The committed migration remains an ordinary reviewable Git diff, while
  publication and rollback retain Foundation's existing recovery semantics.
- The first release containing this command needs one bridge adoption; every
  subsequent qualified Cohort can be selected by the installed source command.

## Rejected alternatives

- Continue documenting manual profile, pin, and lockfile preparation.
- Let pnpm or a postinstall hook mutate the real consumer before staging proof.
- Fetch floating package tags or a mutable registry URL without an exact
  protected Git revision and qualified package integrities.
- Add a second filesystem transaction or generic consumer-management platform.
