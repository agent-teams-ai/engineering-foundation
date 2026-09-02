# Managed Docs Protocol Consumer Integration

Status: Accepted target from ADR-0030 and ADR-0037. The internal bounded-context
dependency fence is implemented and the managed integration is release-qualified;
consumer activation remains explicit.

Terminology follows the [Foundation glossary](../reference/glossary.md).
Release qualification, cohort qualification, consumer qualification, and
admission are separate decisions throughout this document.

## Boundaries

The system has three authorities with one-way dependencies:

```text
.github governance
  Qualified Cohort, enrollment, admission, observed CI
              |
              v
Docs Protocol consumer-integration
  desired state, compiler, diagnostics, managed assets
              |
              v
Engineering Foundation mutation
  barrier, CAS, journal, recovery, receipt, filesystem guards
```

Foundation never imports Docs Protocol. Docs Protocol never owns organization
admission. Consumers retain all repository-specific documentation meaning.

## Legacy Foundation CLI boundary

Docs Protocol is the target command owner. The older Foundation `docs`
namespace remains executable only as the frozen compatibility boundary defined
by [ADR-0033](../decisions/0033-freeze-legacy-foundation-docs-cli.md). Foundation
does not forward that namespace to Docs Protocol or add a reverse dependency.
Human invocations receive the stable `FOUNDATION_DOCS_CLI_DEPRECATED` signal;
machine invocations preserve their published one-envelope stream contract.

The later removal event is evidence-gated, not time-gated. It requires a
complete consumer inventory bound to an exact revision of the append-only
central Cohort registry with zero legacy invocations, exact consumer cutover
evidence, positive and negative parity fixtures, packed-registry artifact
qualification, platform capability qualification, and a closed inventory plus
proven route for every recognized
legacy evidence version. Until then, the compatibility surface is maintained
but cannot evolve.

## Internal Docs Protocol boundary

Within Docs Protocol, consumer integration now follows one enforced source
direction:

```text
composition -> adapters -> application -> domain
             \------------> domain
application -------------> generated package assets
```

Application ports own the repository-observation, package-asset, partial-file
planning, and Foundation transaction needs. The Node composition root supplies
the concrete repository, asset-catalog, manifest, route, and transaction
adapters. Application source cannot import adapter source. The repository source
policy and its golden boundary test reject a reversed edge, undeclared package
or Node builtin, or cross-boundary import that bypasses a declared entrypoint.

This containment changes no public exports or wire schemas. Planning still
sorts the exact asset and operation sets deterministically. Apply still rebuilds
the Plan before comparing `--expect`, delegates the rebuilt mutation Plan to
Foundation, recaptures the repository afterward, and returns Foundation's
unchanged receipt.

## Ownership

| Surface | Owner | Integration authority |
| --- | --- | --- |
| Canonical authoring Skill | Docs Protocol | Full bytes |
| Standalone caller workflow | Docs Protocol plus Qualified Cohort revision | Full bytes |
| Generated managed state | Docs Protocol | Full bytes |
| Six `docs:*` aliases | Docs Protocol | Exact package fields |
| Docs Protocol and Foundation pins | Qualified Cohort | Exact development dependency fields |
| Documentation route in `AGENTS.md` | Docs Protocol | One exact managed block |
| Integration profile Cohort field | `.github` governance via Docs Protocol upgrade | One exact field |
| pnpm lockfile | Package manager plus Foundation publication | Generate only in disposable staging; publish exact postimage |
| Profiles, owners, schemas, templates, validators, documents | Consumer | No write authority |
| Enrolled repositories and exceptions | `.github` governance | External audit and admission |

## Lifecycle

```text
discover -> check source -> stage successor -> prove target -> publish -> check target
         -> review Git diff -> hosted CI -> admission
```

The normal migration is one explicit command:

```bash
agent-teams-docs consumer upgrade --to docs-YYYY-MM-DD-N --json
```

It resolves current protected `.github` main, projects the qualified Cohort and
exact package pins, lets pnpm generate the lockfile only inside a disposable Git
copy, and runs the successor CLI there. Foundation then publishes the closed
postimage set once, after revalidating that the captured SHA is still protected
main. Activation is a frozen offline install plus read-only check;
failure publishes exact reverse operations and restores the source installation.

The source must be current, transaction-idle, and clean at one Git HEAD. The
optional `--authority-revision` is a freshness assertion and must equal current
protected main. The Cohort's `eligible_after` timestamp remains informational;
lifecycle state, canary enrollment, and explicit `upgrade_from` are the local
selection gates.

`check` and `plan` remain deterministic offline observations. `apply` accepts only a newly
rebuilt Plan whose digest equals the caller's expectation, then delegates to the
Foundation recoverable serialized CAS transaction. A crash can expose mixed
bytes until exact-build recovery completes; the transaction journal and hosted
merge gate make that state visible and prevent default-branch admission.

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
