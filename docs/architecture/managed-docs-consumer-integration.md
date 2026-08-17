# Managed Docs Protocol Consumer Integration

Status: Accepted target from ADR-0030 and ADR-0031. Implementation and release
qualification are in progress.

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

## Ownership

| Surface | Owner | Integration authority |
| --- | --- | --- |
| Canonical authoring Skill | Docs Protocol | Full bytes |
| Standalone caller workflow | Docs Protocol plus Qualified Cohort revision | Full bytes |
| Generated managed state | Docs Protocol | Full bytes |
| Six `docs:*` aliases | Docs Protocol | Exact package fields |
| Docs Protocol and Foundation pins | Qualified Cohort | Exact development dependency fields |
| Documentation route in `AGENTS.md` | Docs Protocol | One exact managed block |
| pnpm lockfile | Package manager | Read and validate only |
| Profiles, owners, schemas, templates, validators, documents | Consumer | No write authority |
| Enrolled repositories and exceptions | `.github` governance | External audit and admission |

## Lifecycle

```text
discover -> check -> plan -> review -> apply -> check -> hosted CI -> admission
```

`check` and `plan` are deterministic observations. `apply` accepts only a newly
rebuilt Plan whose digest equals the caller's expectation, then delegates to the
Foundation recoverable serialized CAS transaction. A crash can expose mixed
bytes until exact-build recovery completes; the transaction journal and hosted
merge gate make that state visible and prevent default-branch admission.

## V1 support

V1 is intentionally closed to Node 24, root pnpm 11, one root manifest and
lockfile, GitHub Actions, and one integration root. Unsupported or ambiguous
topologies produce stable diagnostics and no writes. Windows supports check and
plan; apply remains fail-closed until strict replacement durability is separately
qualified.

## Non-goals

- a generic managed-files or plugin framework;
- lockfile generation or dependency installation;
- automatic documentation, profile, schema, template, owner, or validator edits;
- network access during local lifecycle commands;
- multi-file atomicity claims;
- continuous organization-wide compliance before a separate read-only auditor.

