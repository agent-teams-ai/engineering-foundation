# `@agent-teams/docs-protocol`

One deterministic documentation UX for Agent Teams repositories. This package
is a thin application and CLI layer over the versioned mutation kernel exported
by `@agent-teams/engineering-foundation`.

The authoring protocol is independently versioned from its managed consumer
integration. A consumer upgrade selects one externally qualified cohort with
exact package, workflow, provenance, and asset identities.

## Boundary

- Engineering Foundation owns catalogs, Plan/Apply/Receipt, the single writer,
  filesystem safety, transaction evidence, recovery, and strict sidecar merge.
- Docs Protocol owns command semantics, the shared metadata vocabulary,
  relation queries, agent routing, and adoption checks.
- A consumer owns its data-only profiles, metadata schema, owners, templates,
  explicit reachability, and opaque semantic validator IDs.

Profiles cannot contain commands, hooks, callbacks, dynamic imports, remote
references, environment interpolation, or executable consumer code. Semantic
validator IDs are reported by `docs:info` and `docs:check`; this package never
executes them.

## Consumer commands

Install this tooling package at one exact version in `devDependencies`, never in
production `dependencies`. Map these scripts to `agent-teams-docs`:

```text
docs:info     -> agent-teams-docs info
docs:find     -> agent-teams-docs find
docs:new      -> agent-teams-docs new
docs:doctor   -> agent-teams-docs doctor
docs:recover  -> agent-teams-docs recover
docs:check    -> agent-teams-docs check
```

The default protocol profile is
`architecture/foundation/docs-protocol.yaml`. Override it with `--profile`;
override the repository with `--consumer`.

`new` requires exactly one of `--dry-run` or `--apply`. Preview never reserves
an ID or writes. Apply creates only the planned document and reports the exact
index path and Markdown link; it never edits an index.
Every authoring request selects Foundation's closed
`create-missing-real-directories` policy. The resulting Plan v2 may create only
its verified missing parent chain and records directory evidence for recovery.

```bash
agent-teams-docs find --type adr --owner architecture/tooling --related ADR-0004
agent-teams-docs new --type adr --id ADR-0083 --title "Tenant isolation" \
  --owner architecture/tooling --summary "Defines tenant isolation." \
  --blocked-by ADR-0082 --metadata evidence='["test:tenant-isolation"]' --dry-run
```

All filters are combined with AND. Results use binary ID/path ordering and zero
matches are success. `related`, `blocked_by`, and `code_anchors` are the stable
v1 vocabulary. Repeat `--code-anchor` with one strict JSON value. Repeat
`--metadata key=<strict JSON>` for additional consumer-schema-validated data.

## Profile routing

The protocol profile routes to a Foundation authoring profile v2. Foundation
alone loads inline frontmatter and any declared metadata sidecar, performs the
strict path-to-full-metadata merge, validates the final instance, and exposes a
bounded inert metadata projection. Docs Protocol never reparses documents.

The referenced Foundation profile v2 is the only authority for authorable
types, identity, placement, heading, owners, required metadata, and explicit
reachability. `not-required` requires a human-readable reason; omission is
invalid. The Docs Protocol profile contains only routing, protocol identity,
the agent Skill route, and opaque semantic validator IDs.

The JSON schemas are exported under `@agent-teams/docs-protocol/schemas/*`.
Machine output uses one JSON envelope with protocol ID/version and stable exit
codes: `0` success, `1` violation/conflict/recovery, `2` invalid input, `3`
execution failure, and `130` cancellation.
Recovery is bound to the persisted transaction and exact installed Foundation
build, so it does not parse mutable authoring profiles before resuming.

## Maintainer lifecycle

Daily authoring commands stay unchanged. Integration maintenance uses a separate
namespace and the committed
`architecture/foundation/docs-consumer-integration.json` profile:

```bash
agent-teams-docs consumer check --json
agent-teams-docs consumer plan --to docs-YYYY-MM-DD-N --json
agent-teams-docs consumer apply --expect sha256:EXACT_PLAN_DIGEST --json
agent-teams-docs consumer recover --json
```

`check` and `plan` are write-free and offline. `apply` recompiles the Plan,
requires its exact digest, and delegates all writes to Foundation's recoverable
known-file transaction. The integration never edits a lockfile, documentation
profile, owner catalog, schema, template, validator, or governed document.

V1 supports only one root pnpm 11 integration on Node 24 and GitHub Actions.
Other package managers and mixed lockfiles fail closed. Windows supports check
and plan; apply and recovery refuse until strict directory durability has a
separate qualification.

## Consumer qualification

`@agent-teams/docs-protocol/qualification` exports
`runDocsProtocolQualification`. A consumer supplies a deliberately disposable
fixture and one authoring scenario. The runner copies that fixture into its own
temporary directory, then proves info, deterministic find, preview/apply parity,
explicit reachability, check, doctor, and recovery end to end. It rejects fixture
symlinks, verifies that the source tree did not change, and removes only the
temporary directory it created.
