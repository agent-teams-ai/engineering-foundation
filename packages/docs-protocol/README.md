# `@agent-teams/docs-protocol`

A deterministic, repository-native documentation library and CLI for humans
and coding agents. It keeps Markdown/YAML as authority, provides safe
create-only authoring, advisory fuzzy search, bounded `llms.txt` context, and a
portable setup that does not require an Agent Teams managed repository.

The package is a thin application layer over the versioned mutation kernel in
`@agent-teams/engineering-foundation`. The optional read-only MCP transport is
published separately as `@agent-teams/docs-protocol-mcp`.

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

## Portable quick start

Use the [canonical community workflow](https://github.com/agent-teams-ai/engineering-foundation/blob/main/docs/reference/open-source-docs-protocol.md#install-one-exact-version)
to prove and install the exact artifact-qualified coordinate. It is the single authority
for versions, registry pinning, package-manager support, and optional MCP pairing.

Portable bootstrap apply and recovery are initially POSIX-only. Windows is
capability-qualified for read-only CLI and MCP use of authority initialized on a supported
POSIX host, committed, and then cloned; local Windows bootstrap mutation is not
yet a support claim.

Preview setup without writing:

```bash
docs-protocol init --project-id example/widgets \
  --owner documentation/team --dry-run --json
```

Review the returned files and digest, then repeat the same authority inputs:

```bash
docs-protocol init --project-id example/widgets \
  --owner documentation/team --apply \
  --expect sha256:PLAN_DIGEST_FROM_PREVIEW --json
```

Bootstrap creates inert local profiles, a metadata schema, owners, Diataxis
templates and indexes, a documentation Skill, and one marker-bounded route in
`AGENTS.md`. It does not edit a package manifest, lockfile, workflow, or existing
create-only target. A changed preimage requires a fresh preview.

The generated `docs.config.yaml` is discovered automatically:

```bash
docs-protocol find "tenant isolation" --fuzzy
docs-protocol context "tenant isolation" --fuzzy --max-documents 12
docs-protocol new --type tutorial --id docs.tutorial.first-run \
  --title "First run" --owner documentation/team \
  --summary "Complete the first successful run." --dry-run
docs-protocol check
```

Use the same explicit `new` inputs with `--apply` only after reviewing the
preview. Fuzzy ranking and context are disposable advice; identity, metadata,
paths, collision checks, and writes always come from the canonical catalog.
The public Node API exposes the same info/find/context/new/check and portable
init plan/apply/recover behavior without a terminal.

See the [community workflow](https://github.com/agent-teams-ai/engineering-foundation/blob/main/docs/reference/open-source-docs-protocol.md)
for the complete safety contract.

## Portable commands

Install this tooling package at one exact version in `devDependencies`, never in
production `dependencies`. The portable profile is `docs.config.yaml`; override
it explicitly with `--profile` and override the repository with `--consumer`.

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

The portable v3 protocol profile routes to a Foundation authoring profile v3. Foundation
alone loads inline frontmatter and any declared metadata sidecar, performs the
strict path-to-full-metadata merge, validates the final instance, and exposes a
bounded inert metadata projection. Docs Protocol never reparses documents.

The referenced Foundation profile is the only authority for authorable
types, identity, placement, heading, owners, required metadata, and explicit
reachability. `not-required` requires a human-readable reason; omission is
invalid. The Docs Protocol profile contains only routing, protocol identity,
the agent Skill route, and opaque semantic validator IDs.

The portable JSON schemas are exported under
`@agent-teams/docs-protocol/schemas/*`.
Machine output uses one JSON envelope with protocol ID/version and stable exit
codes: `0` success, `1` violation/conflict/recovery, `2` invalid input, `3`
execution failure, and `130` cancellation.
Generic v1/v2 commands retain their existing envelope shapes. Portable
`init`, bounded `context`, and opt-in fuzzy `find` use the additive v3 envelope;
default exact `find` remains v2. Consumers must dispatch on `schemaVersion` and
validate against the matching exported schema.
Recovery is bound to the persisted transaction and exact installed Foundation
build, so it does not parse mutable authoring profiles before resuming.

## Consumer qualification

`@agent-teams/docs-protocol/qualification` exports
`runDocsProtocolQualification`. A consumer supplies a deliberately disposable
fixture and one authoring scenario. The runner copies that fixture into its own
temporary directory, then proves info, deterministic find, preview/apply parity,
explicit reachability, check, doctor, and recovery end to end. It rejects fixture
symlinks, verifies that the source tree did not change, and removes only the
temporary directory it created.

Managed cohort qualification is intentionally outside this package. Agent Teams users
install `@agent-teams/docs-protocol-agent-teams` and use its distinct
`agent-teams-docs-managed` executable; the portable core neither discovers nor
imports that adapter.
