---
id: ADR-0031
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0031: Managed Docs Protocol Consumer Integration

Status: Accepted

Date: 2026-08-16

Decision owner: Product owner

## Context

The initial Docs Protocol rollout proved one daily command vocabulary across
four consumers, but every repository still copied scripts, agent routing,
Skill, caller workflow, package pins, and qualification metadata manually.
Those copies can drift before documentation growth makes upgrades expensive.

The integration lifecycle is documentation-specific, while filesystem mutation
is not. Adding integration methods to `DocsProtocol` or write behavior to
`NodeDocsAdoptionInspector` would mix daily authoring, adoption inspection, and
maintenance mutation in one application object.

## Decision

1. `consumer-integration` is a separate bounded context inside
   `@agent-teams/docs-protocol`. It has its own domain model, use cases, ports,
   adapters, composition root, schemas, CLI commands, and tests.
2. No third npm package is created. The release cadence and runtime dependency
   remain aligned with Docs Protocol.
3. Daily `DocsProtocol` commands and the local 20 to 30 line authoring Skill stay
   unchanged. Maintainer commands are separate:
   `consumer check`, `consumer plan --to <exact-cohort>`, and
   `consumer apply --expect <plan-digest>`.
4. `check` and `plan` are offline and write-free. They create no lock, cache,
   temporary, journal, receipt, telemetry, or mtime change.
5. A Qualified Cohort is the upgrade unit. Floating npm tags and independent
   package updates are not authority. The local desired cohort is human-owned;
   committed managed state is generated; Foundation transaction evidence is
   local and uncommitted; hosted CI observation remains external governance
   evidence.
6. Full-byte ownership is limited to the canonical Skill, standalone caller
   workflow, and managed state. Partial ownership is limited to six docs scripts,
   two development dependency fields, and one exact managed route block in
   `AGENTS.md`. Lockfiles, profiles, owners, schemas, templates, validators, and
   documentation remain outside mutation authority.
7. Unknown files, unknown managed hashes, duplicate JSON keys, reserved script
   collisions, ambiguous roots, nested routing conflicts, symlinks, multiple
   lockfiles, and unsupported package managers fail closed.
8. V1 supports Node 24, root pnpm 11, one root manifest, one root lockfile,
   GitHub Actions, and one integration root. Other topologies report
   `unsupported` without partial changes.
9. Apply rebuilds the Plan, compares its expected digest, and delegates the
   exact operation set to Foundation's `replace-known-file/v1` port. It never
   executes operations from an untrusted saved plan and has no force mode.
10. The package manager remains the only lockfile writer. The reviewed upgrade
    branch updates exact dependency pins and the lockfile before the new CLI
    updates managed assets.

## Consequences

- Agents retain a small stable daily workflow while maintainers gain a
  deterministic upgrade lifecycle.
- Consumer-specific documentation authority stays local and byte-stable.
- Shared integration behavior evolves once without a second mutation engine.
- Bootstrap still requires a reviewed branch because an old CLI cannot install
  or generate its own successor.

## Rejected alternatives

- A universal consumer kit for unrelated repository policy.
- A third independently versioned integration package.
- Postinstall mutation, network-backed templates, `npx ...@latest`, callbacks,
  consumer hooks, or package-manager execution from the integration CLI.
- Expanding `NodeDocsAdoptionInspector` into planner and writer responsibilities.

