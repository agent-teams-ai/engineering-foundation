# Managed Docs Protocol Consumer Integration

Status: Accepted behavior from ADR-0030 and ADR-0037, relocated by ADR-0043 to
the new-only `@agent-teams/docs-protocol-agent-teams` package. Consumer
activation remains explicit.

Terminology follows the [Foundation glossary](../reference/glossary.md).
Release qualification, cohort qualification, consumer qualification, and
admission are separate decisions throughout this document.

## Boundaries

Organization governance owns Qualified Cohort, enrollment, admission, and
observed CI. Docs Protocol Agent Teams owns managed desired state, compilation,
diagnostics, and assets. It composes the portable Docs Protocol public API and
Repository Mutation without moving managed behavior into either dependency.
Portable Docs Protocol never imports, discovers, or executes the managed
adapter. Repository Mutation supplies only the barrier, exact-preimage
transactions, journals, receipts, filesystem guards, and exact-build recovery
mechanism. Consumers retain all repository-specific documentation meaning. The
sole authoritative package DAG remains in
[ADR-0043](../decisions/0043-new-only-portable-documentation-package-boundary.md).

## New-only command boundary

Managed operations use only the distinct `agent-teams-docs-managed` executable
from Docs Protocol Agent Teams. Portable `agent-teams-docs` and `docs-protocol`
contain only portable commands. Engineering Foundation has no documentation
CLI, and no package supplies an alias, forwarding command, optional adapter
lookup, or compatibility bridge. Removing those user-facing routes does not
remove recognized journals or exact-build recovery handlers during their
support windows.

## Internal managed-adapter boundary

Within Docs Protocol Agent Teams, consumer integration follows one enforced
source direction:

```text
composition -> adapters -> application -> domain
             \------------> domain
application -------------> generated package assets
```

Application ports own the repository-observation, package-asset, partial-file
planning, and Repository Mutation transaction needs. The Node composition root
supplies the concrete repository, asset-catalog, manifest, route, and
transaction adapters. Application source cannot import adapter source. The
repository source policy and its golden boundary test reject a reversed edge,
undeclared package or Node builtin, or cross-boundary import that bypasses a
declared entrypoint.

This containment changes no persisted wire schemas. Planning still
sorts the exact asset and operation sets deterministically. Apply still rebuilds
the Plan before comparing `--expect`, delegates the rebuilt mutation Plan to
Repository Mutation, recaptures the repository afterward, and returns its
unchanged receipt.

## Ownership

| Surface | Owner | Integration authority |
| --- | --- | --- |
| Canonical authoring Skill | Docs Protocol Agent Teams | Full bytes |
| Standalone caller workflow | Docs Protocol Agent Teams plus Qualified Cohort revision | Full bytes |
| Generated managed state | Docs Protocol Agent Teams | Full bytes |
| Six `docs:*` aliases | Docs Protocol Agent Teams | Exact package fields |
| Docs Protocol package pins | Qualified Cohort | Exact development dependency fields |
| Documentation route in `AGENTS.md` | Docs Protocol Agent Teams | One exact managed block |
| Integration profile Cohort field | `.github` governance via managed upgrade | One exact field |
| pnpm lockfile | Package manager plus managed transaction | Generate only in disposable staging; publish exact postimage |
| Profiles, owners, schemas, templates, validators, documents | Consumer | No write authority |
| Enrolled repositories and exceptions | `.github` governance | External audit and admission |

## Lifecycle

```text
discover -> check source -> stage successor -> prove target -> publish -> check target
         -> review Git diff -> hosted CI -> admission
```

The normal migration is one explicit command:

```bash
agent-teams-docs-managed upgrade --to docs-YYYY-MM-DD-N --json
```

It resolves current protected `.github` main, projects the qualified Cohort and
exact package pins, lets pnpm generate the lockfile only inside a disposable Git
copy, and runs the successor CLI there. Repository Mutation then publishes the
closed postimage set once, after revalidating that the captured SHA is still
protected main. Activation is a frozen offline install plus read-only check;
failure publishes exact reverse operations and restores the source installation.

The source must be current, transaction-idle, and clean at one Git HEAD. The
optional `--authority-revision` is a freshness assertion and must equal current
protected main. The Cohort's `eligible_after` timestamp remains informational;
lifecycle state, canary enrollment, and explicit `upgrade_from` are the local
selection gates.

`check` and `plan` remain deterministic offline observations. `apply` accepts
only a newly rebuilt Plan whose digest equals the caller's expectation, then
delegates to the Repository Mutation recoverable serialized CAS transaction. A
crash can expose mixed bytes until exact-build recovery completes; the
transaction journal and hosted merge gate make that state visible and prevent
default-branch admission.

## V1 support

V1 is intentionally closed to Node 24, root pnpm 11, one root manifest and
lockfile, GitHub Actions, and one integration root. Unsupported or ambiguous
topologies produce stable diagnostics and no writes. Windows supports check and
plan; apply remains fail-closed until the Windows mutation adapter passes
separate capability qualification.

## Non-goals

- a generic managed-files or plugin framework;
- package installation outside the explicit disposable upgrade and frozen activation boundary;
- automatic documentation, profile, schema, template, owner, or validator edits;
- network access during `check`, `plan`, `apply`, or `recover`;
- multi-file atomicity claims;
- continuous organization-wide compliance before a separate read-only auditor.
