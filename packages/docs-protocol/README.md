# `@agent-teams/docs-protocol`

A deterministic, repository-native documentation library and CLI for humans
and coding agents. It keeps Markdown/YAML as authority, provides safe
create-only authoring, advisory fuzzy search, bounded `llms.txt` context, and a
portable setup that does not require an Agent Teams managed repository.

The package is the portable application layer over direct dependencies on
`@agent-teams/document-authoring` and `@agent-teams/repository-mutation`. The
optional read-only MCP transport is published separately as
`@agent-teams/docs-protocol-mcp`.

## Boundary

- Document Authoring owns authoring contracts, catalogs, Plans, Receipts,
  deterministic compilation, protected materialization, and strict sidecar merge.
- Repository Mutation owns the operation barrier, journal persistence,
  filesystem mutation safety, and exact-build recovery mechanism.
- Docs Protocol owns portable application and command semantics, the shared metadata vocabulary,
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

The generated `docs.config.yaml` is discovered automatically. Preview a decision:

```bash
docs-protocol new --type adr --id ADR-0001 --title "Portable documentation" \
  --owner documentation/team --summary "Adopt portable documentation." \
  --dry-run --json
```

Review its compiled bytes, then apply the **new-document** preview digest:

```bash
docs-protocol new --type adr --id ADR-0001 --title "Portable documentation" \
  --owner documentation/team --summary "Adopt portable documentation." \
  --apply --expect sha256:NEW_PLAN_DIGEST_FROM_PREVIEW --json
```

Add the returned `markdownLink` to the returned `indexPath`, then verify:

```bash
docs-protocol find "portable documentation" --fuzzy --json
docs-protocol context "portable documentation" --fuzzy --max-documents 12 --json
docs-protocol check --json
```

Fuzzy ranking and context are disposable advice; identity, metadata, paths,
collision checks, and writes come from the canonical catalog. The public Node
API exposes the same operations without a terminal.

See the [community workflow](https://github.com/agent-teams-ai/engineering-foundation/blob/main/docs/reference/open-source-docs-protocol.md)
for the complete safety contract.

## Portable commands

Install this tooling package at one exact version in `devDependencies`, never in
production `dependencies`. The portable profile is `docs.config.yaml`; override
it explicitly with `--profile` and override the repository with `--consumer`.

`new` requires exactly one of `--dry-run` or `--apply`. Preview never reserves
an ID or writes. For reviewed Apply, pass its `planDigest` as `--expect` (Node:
`DocsNewRequest.expectedPlanDigest`). Malformed digests return `invalid-input`
(exit 2); a different compiled Plan returns `authority-stale` (exit 1). Both
have no mutation effects. `--expect` is valid only with `--apply`. Explicit
direct `--apply` without `--expect` compiles and applies current authority;
it does not claim approval of an earlier preview. Matching the digest still
requires current profile policy, authority, anchors, and transaction checks.

Apply creates only the planned document and reports the exact
index path and Markdown link; it never edits an index.
Every authoring request selects Document Authoring's closed
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

Portable profile v4 routes to a Document Authoring profile v3. Existing portable
profile v3 remains readable with its historical semantics.
Document Authoring alone loads inline frontmatter and any declared metadata
sidecar, performs the strict path-to-full-metadata merge, validates the final
instance, and exposes a bounded inert metadata projection. Docs Protocol never
reparses documents.

The referenced Document Authoring profile is the only authority for authorable
types, identity, placement, heading, owners, required metadata, and explicit
reachability. `not-required` requires a human-readable reason; omission is
invalid. The Docs Protocol profile contains only routing, protocol identity,
the agent Skill route, opaque semantic validator IDs, and v4's required data-only
`relations.blockers` policy. Its `types` and `statuses` admit blocker targets;
`subjectIncompatibleStatuses` forbids blockers on those subject states. Starter
v4 data permits proposed ADR/Diataxis blockers; consumers choose their own
vocabulary. [Profile v4 migration](docs/profile-v4.md) records wire identities,
frozen v3 compatibility, portable path rules, migration and rollback.

Metadata JSON Schema `format` is an annotation: Document Authoring uses
`validateFormats: false`. It does not assert URI, date, or other format validity.
Use explicit supported schema constraints when validity is required.
The [data-only feature example](docs/feature-module-example.md) demonstrates
consumer-owned DDD/Clean boundaries using the existing source policy schema.

The portable JSON schemas are exported under
`@agent-teams/docs-protocol/schemas/*`.
Machine output uses one JSON envelope with protocol ID/version and stable exit
codes: `0` success, `1` violation/conflict/stale/recovery, `2` invalid input, `3`
execution failure, and `130` cancellation.
Human `--help`, subcommand `--help`, and `--version` use stdout and exit 0.
With `--json`, help/version return a schema-valid invocation error on stdout,
exit 2, and empty stderr; their human text has no JSON success contract.
Generic v1/v2 commands retain their existing envelope shapes. Portable
`init`, bounded `context`, and opt-in fuzzy `find` use the additive v3 envelope;
default exact `find` remains v2. Consumers must dispatch on `schemaVersion` and
validate against the matching exported schema.
Recovery is bound to the persisted transaction and exact installed Document
Authoring build, so it does not parse mutable authoring profiles before
resuming. Historical wire names that contain `foundation` remain unchanged
persisted contract identities.

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
