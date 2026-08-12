---
id: ADR-0022
status: superseded
supersedes: []
superseded_by:
  - ADR-0023
---

# ADR-0022: Document Authoring Protocol

Status: Accepted

Date: 2026-08-12

Decision owner: Product owner

## Context

ADR-0007 assigns generic documentation integrity to Foundation while leaving
document meaning and repository policy with each consumer. That read-only
boundary does not define how an automated agent may create a governed document.
Treating creation as another capability or as a scaffolding recipe would either
hide mutation inside `foundation check` or distort the documentation domain.

A reusable writer also needs a truthful filesystem contract. Portable Node
filesystems cannot provide a hostile-process sandbox or a multi-file atomic
transaction. The protocol must state that boundary before runtime code exists.

## Decision

1. Define document authoring as a separate top-level Foundation protocol. It is
   not an executable capability and never runs as part of a read-only check.
2. Keep consumer repositories authoritative for document types, lifecycle,
   owner identifiers, metadata schemas, templates, placement meaning, body
   rules, relationships, code anchors, and prose or diagram tools.
3. Use a closed `DocumentIntent -> DocumentPlan -> Apply -> DocumentReceipt`
   flow. Document contracts remain distinct from scaffolding contracts, and no
   public generic filesystem mutation API is introduced.
4. Limit profile v1 to data-only, create-only primitives with explicit
   identities, one new file, an existing real parent directory, a bounded local
   template, and closed identity, placement, filename, and heading strategies.
   Profiles cannot contain commands, callbacks, hooks, dynamic imports, remote
   references, inheritance, conditions, or arbitrary patterns.
5. Coordinate every Foundation mutation through one repository operation lock
   and one physical active transaction slot. The version 2 transaction envelope
   dispatches only Foundation-registered recovery handlers. Unknown or newer
   envelopes fail closed and are preserved.
6. Promise cooperative serialization, no overwrite, exact-byte verification,
   journaled recovery, and no automatic deletion after publication. Do not
   promise isolation from a hostile same-user process, identical power-loss
   durability across filesystems, or semantic correctness of authored content.
7. Publish closed schemas for profile, Intent, Plan, Receipt, transaction
   envelope, and JSON command envelope before implementing the writer. A
   protocol version change is required to reinterpret their meaning.
8. Keep portals, persistent search indexes, automatic sequence allocation,
   directory creation, generic Markdown editing, managed index updates, and
   organization enforcement outside this protocol version.

## Compatibility direction and support window

The version 2 transaction envelope is the narrow migration boundary required by
ADR-0019. The persisted version 1 scaffolding journal already occupies the one
physical transaction slot. A repository may therefore contain old persisted
work while its exact package version changes, and an older package may encounter
a document transaction created by a newer package.

- A package that supports envelope v2 must continue reading the legacy
  scaffolding journal v1 and the document-authoring payload v1 inside envelope
  v2.
- A package that understands only the legacy journal must reject envelope v2 as
  unknown, preserve it byte-for-byte, and refuse every new Foundation mutation.
- No version automatically rewrites a nonterminal journal. Recovery uses the
  compatible exact package version recorded by the envelope.
- Legacy journal reading remains supported while any supported exact Foundation
  release can have created that persisted form.
- Retirement requires organization inventory proving zero nonterminal legacy
  journals, removal of every supported writer that can create one, and a new
  accepted ADR defining the final removal release. Time alone is not retirement
  evidence.

## Consequences

- Agents get one future authoring route without moving repository-specific
  documentation semantics into Foundation.
- The first implementation can reuse internal transaction mechanisms while its
  public language stays separate from scaffolding.
- A package upgrade or downgrade is unsafe while a nonterminal transaction
  exists. Recovery must use a compatible exact Foundation version.
- Once any planned output has been published, automated rollback may complete,
  preserve, recover, or request manual resolution, but it may not delete that
  output.
- This ADR and its schemas define contracts only. No document writer, catalog,
  query command, or recovery handler is available until later qualified phases.

## Rejected alternatives

- Model document creation as another scaffolding recipe.
- Export a consumer-programmable mutation kernel.
- Run consumer commands, JavaScript, template engines, or network tools from a
  profile.
- Claim a cross-platform transaction or security sandbox stronger than the
  filesystem evidence Foundation can observe.

The target contract is defined by
[Document authoring protocol](../architecture/document-authoring-protocol.md),
and its security boundary is defined by the
[cooperative writer threat model](../security/document-authoring-threat-model.md).
