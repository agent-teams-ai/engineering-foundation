---
id: ADR-0013
status: superseded
supersedes: []
superseded_by:
  - ADR-0018
---

# ADR-0013: Source-Bound Scaffolding Authority Evidence

Status: Accepted

Date: 2026-08-03

Decision owner: Product owner

## Context

The released `0.5.0` provisional scaffolding contract binds a Plan to the consumer configuration
and target catalog. A consumer can separately require an accepted owner document,
but that document is not part of the Plan read set. A document may therefore be
revoked, replaced, or rebound after planning without changing the files that
Apply or Recover recheck.

An external preflight does not close this race. A persistent generated authority
index would create a second source of truth beside the catalog and documents. An
opaque consumer-produced `allow` assertion would also be forgeable unless
Foundation independently reproduced its semantics.

The first reusable package recipe must not be qualified on authority that the
closed compiler cannot reproduce from canonical consumer sources.

## Decision

1. Publish one canonical source-bound scaffolding API without parallel public
   variants, compatibility routers, or legacy methods. Persisted artifacts retain
   explicit format discriminators
   so unsupported old state fails closed instead of being misinterpreted.
2. The consumer remains authoritative for target ownership, owner document
   identity, the configured document roots, and the statuses allowed by one
   Composition. These facts are strict data, never callbacks or executable
   policy.
3. Foundation owns an allowlisted generic verifier for Markdown documents with
   strict YAML frontmatter. The verifier reads the canonical document itself and
   checks the target-bound document ID and allowed status. It does not trust a
   consumer-produced decision result.
4. The target catalog binds only the owner document ID. The selected Composition
   declares bounded repository document roots. Foundation deterministically
   resolves the ID exactly once from strict Markdown frontmatter and derives the
   repository path. The resolved document remains the source of truth for its
   status and metadata; consumers never duplicate its path in the catalog.
5. An Authority Evidence record binds the verifier identity and contract
   version, project and target identities, a canonical target identity digest,
   observed owner identity and status, every canonical source assertion, and
   its own content digest.
6. Configuration, catalog, and the resolved owner document assertions are
   included in the complete Plan read set, authority snapshot digest, Authority
   Evidence digest, and Plan digest. Resolution scans the bounded roots in a
   deterministic order under fixed entry, document, and depth budgets and
   repeats the metadata index during source stability verification. Missing or
   duplicate selected IDs, overlapping roots, unknown verifiers or fields, and
   unsafe source paths fail closed. Consumer-specific frontmatter outside the
   validated `id` and `status` projection is inert.
7. Apply and Recover recompile the exact Plan and recheck the complete authority
   read set while holding the Foundation operation lock. Each verification reads
   every canonical source, then repeats the source-set digest reads to reject a
   persistent mutation during acquisition. Finalization performs two ordered
   authority/output stability passes (`A-C-A-C`). Completion of the final output
   classification is the commit boundary within the cooperative mutation model;
   a later edit is a subsequent mutation.
   Every Foundation-aware automated writer of configuration, catalog, owner
   documents, and scaffold outputs must acquire the same repository Foundation
   operation lock. Repeated reads detect ordinary concurrent edits, but do not
   create a linearizable transaction with an uncooperative same-identity writer.
8. The journal records publication progress, but repository-writable journal
   state, process-local observation, and matching bytes are not trusted proof of
   current output ownership. Once journal publication begins, stale or
   unverifiable authority never triggers automatic deletion. Foundation keeps
   outputs and journal and reports `recovery-required` with `unobserved`
   operation outcomes when no safe classification was performed.
9. Authority Evidence does not qualify or activate a product Recipe. Recipe
   extraction still requires a real accepted donor vertical and a second
   consumer under ADR-0006.
10. The canonical API does not interpret or convert `0.5.0` Plans, Receipts, or
    journals. Consumers must complete pending recovery with the exact `0.5.0`
    registry artifact before upgrade. Encountering old durable state fails
    closed with migration guidance.

## Consequences

- Owner revocation, rebinding, source mutation, or moving the selected owner
  document invalidates a saved Plan and prevents further publication by
  cooperative Foundation-aware writers.
- Recovery cannot continue an authority-bearing transaction from an opaque or
  self-asserted consumer proof.
- Consumers keep business vocabulary and document policy; Foundation gains only
  a reusable source verifier and protocol evidence model.
- The portable filesystem adapter never derives deletion authority from
  journal state, process-local observations, or byte equality. An exact
  third-party replacement is preserved.
- Transaction and journal temporary paths are deleted only while their portable
  file identity still matches the handle created by Foundation. A replaced temp
  is preserved and forces recovery.
- The canonical scaffolding surface has the approved public API fingerprint
  `sha256:505922ffad5df5a690a4000832916dac2d6d25c315dc3da65dd575eef04c0b38`.
  The approval covers removal of the provisional dual-version surface.
- Consumers see one source-bound API and one set of supported semantics.
- The immutable `0.5.0` registry artifact remains the recovery path for its
  provisional durable state; the current package does not carry a second public
  protocol implementation.
- The portable Node.js adapter still does not claim protection against a
  hostile same-OS-identity path race or an authority edit that deliberately
  evades repeated source-set reads outside the cooperative threat model.

## Rejected alternatives

- Run only a consumer topology check immediately before Plan and Apply.
- Add paths to the read set without independently checking subject, owner ID,
  and status semantics.
- Treat a generated authority index as canonical.
- Accept an unsigned consumer-produced `decision: allow` proof.
- Duplicate owner document IDs and paths in the target catalog.
- Load consumer JavaScript verifiers, hooks, templates, or plugins.
- Preserve a parallel legacy API or expose version-selection methods.
