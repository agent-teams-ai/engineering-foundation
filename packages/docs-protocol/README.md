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

The protocol profile routes to a Foundation authoring profile v2 or v3. Foundation
alone loads inline frontmatter and any declared metadata sidecar, performs the
strict path-to-full-metadata merge, validates the final instance, and exposes a
bounded inert metadata projection. Docs Protocol never reparses documents.

The referenced Foundation profile is the only authority for authorable
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
agent-teams-docs consumer upgrade --to docs-YYYY-MM-DD-N --json
agent-teams-docs consumer plan --to docs-YYYY-MM-DD-N --json
agent-teams-docs consumer apply --expect sha256:EXACT_PLAN_DIGEST --json
agent-teams-docs consumer recover --json
```

`upgrade` is the normal Cohort migration. It resolves current protected
`.github` authority, projects the Cohort and two exact package pins, generates
the lockfile with pnpm in a disposable Git copy, and proves the installed target
CLI before Foundation publishes the closed postimage set. The real activation
is a frozen offline install plus read-only check; a failure restores the exact
source files and package set.

The command requires a clean Git HEAD, an idle Foundation transaction, and a
source Cohort that already passes `consumer check`. It preserves consumer-owned
profile fields and arbitrary manifest/workspace content. `eligibleAfter` is
evidence, not a local wait gate. `--authority-revision` may assert freshness but
must equal current protected main.

`check` and `plan` are write-free and offline. `apply` recompiles the Plan,
requires its exact digest, and delegates all writes to Foundation's recoverable
known-file transaction. The integration never edits a lockfile, documentation
profile, owner catalog, schema, template, validator, or governed document.

V1 supports only one root pnpm 11 integration on Node 24 and GitHub Actions.
Other package managers and mixed lockfiles fail closed. Windows supports check
and plan; apply and recovery refuse until strict directory durability has a
separate qualification.

If source check reports recovery, run the current build's
`consumer recover --json` first. Replacing the installed build while its journal
is active remains unsupported and fails the upgrade. The lower-level
`plan`/`apply` path remains available for diagnosis and managed-asset repair;
it is no longer a prerequisite for Cohort authority, pins, or lockfile updates.

## Consumer qualification

`@agent-teams/docs-protocol/qualification` exports
`runDocsProtocolQualification`. A consumer supplies a deliberately disposable
fixture and one authoring scenario. The runner copies that fixture into its own
temporary directory, then proves info, deterministic find, preview/apply parity,
explicit reachability, check, doctor, and recovery end to end. It rejects fixture
symlinks, verifies that the source tree did not change, and removes only the
temporary directory it created.

Qualification v2 replaces consumer-owned test code with one strict data file.
The managed integration profile uses `schemaVersion: 2` and declares only the
fixed qualification contract path and external governance gate. The contract
contains exactly one scenario for every authorable type:

```json
{
  "schemaVersion": 2,
  "scenarios": [{
    "id": "adr",
    "type": "adr",
    "intent": {
      "id": "ADR-9001",
      "title": "Qualification",
      "owner": "architecture/tooling",
      "summary": "Proves the disposable authoring roundtrip."
    },
    "expected": {
      "documentPath": "docs/decisions/9001-qualification.md",
      "metadataStorage": "frontmatter",
      "reachability": {
        "state": "manual-required",
        "indexPath": "docs/decisions/README.md",
        "markdownLink": "[ADR-9001: Qualification](9001-qualification.md)"
      }
    }
  }]
}
```

Run `agent-teams-docs qualify --consumer . --json`. The package derives pins,
profile and contract paths, and the declared gate from managed integration. It
never executes that gate or other consumer code. It copies the consumer into an
owned temporary directory while excluding `.git`, `node_modules`, and
`.agent-teams-local`, then runs package-owned info/find/check/doctor/recover and
per-scenario preview/apply/golden checks. The single-file writer always emits
canonical frontmatter. A configured metadata sidecar remains read-only catalog
authority and is qualified by the suite-wide strict merge roundtrip.

V1 `runDocsProtocolQualification` remains available during migration. Invoking
the v2 CLI with v1 managed or qualification authority returns
`DOCS_QUALIFICATION_V1_MIGRATION_REQUIRED`; move pins, paths, and the gate to the
managed integration profile and retain only scenario data in the v2 contract.
For pre-release testing, `--local-development` overlays the current package's
canonical managed Skill only inside the disposable copy. Its receipt has
`evidenceClass: "local-development"` and `cohortAdmissible: false`; governance
and released-cohort rollout must reject that evidence. The default remains
strict released-cohort qualification.
