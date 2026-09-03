# Portable Documentation Consumer Inventory

Status: preparation only. This inventory does not authorize publication or
consumer mutation.

Snapshot: 2026-09-03  
Consumer head: `agent-teams-ai/agent-teams-orchestrator@5768a6465cdcce37a599bca4c60cc94fa967f327`  
Source head: `engineering-foundation@fd5908adc793c8be657ef3e340e4fc954719b374`

## Known current consumer

`agent-teams-orchestrator` is the only organization repository returned by the
default-branch GitHub code search for the current documentation package names
and commands at this snapshot. It currently uses:

- `@agent-teams/docs-protocol@0.4.1`;
- `@agent-teams/engineering-foundation@0.21.0`;
- the `agent-teams-docs` CLI for `info`, `find`, `new`, `check`, `doctor`, and
  `recover`;
- `architecture/foundation/docs-protocol-managed-state.json` with a Cohort
  record and managed state schema v1;
- `.github/workflows/docs-protocol.yml` and repository-local docs-authoring
  fixtures.

The exact current references are in the consumer's `package.json`,
`pnpm-workspace.yaml`, `pnpm-lock.yaml`, managed-state file, workflow, and
`scripts/docs/*` qualification tests. No current consumer uses the new
`@agent-teams/document-authoring`, `@agent-teams/repository-mutation`, or
`@agent-teams/docs-protocol-agent-teams` coordinates yet.

## Evidence limits

The search covers organization default branches and exact package/command
strings. It is not proof that private, generated, historical, or uncommitted
consumer content is absent. The consumer has no committed
`.document-transition`, `.document-quarantine.*`, or `.document-retired.*`
file, so its admitted in-flight transaction generations remain **unknown** and
must be checked before any migration PR.

## Required migration inputs

Before publication or adoption, the consumer owner must provide:

1. an exact current commit and clean worktree proof;
2. a persisted-transaction/recovery-generation inventory, including any
   in-flight or terminal evidence;
3. target published versions and SHA-512 integrity for all required packages;
4. a lockfile diff replacing the old Foundation/Docs Protocol coordinates with
   exact new-only package pins;
5. managed adapter placement and recovery instructions;
6. required consumer CI and rollback evidence.

No bridge, runtime autodetection, floating range, or automatic migration is
part of the prepared path.
