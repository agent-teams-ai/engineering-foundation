---
id: ADR-0054
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0054: Hardening Public API Dispositions

Status: Accepted after independent semantic review

Date: 2026-09-06

Decision owner: Product owner

## Scope and authority

Propose the three complete TypeScript API dispositions observed at
`b76515c00dcb070245855b9dccefb4ef1ba8c1f3`, against its integrated release
baselines from `c1ef6cb`. This proposal changes no public implementation, schema,
package version, approved fingerprint configuration or released baseline.
The [existing procedure](../architecture/public-api-compatibility.md) remains
sole admission authority. Proposed Markdown does not provide accepted evidence.
ADR-0049 remains accepted and immutable; this proposal supersedes no decision.

The current baselines are Mutation 0.1.1, Authoring 0.2.0 and Docs Protocol 0.5.1.
Authoring 0.2.0 already includes all four ADR-0049 signatures. Its generic Plan
and Receipt unions therefore are **not** new changes against this release.
The earlier 8fde audit's complete Authoring fingerprint and synthetic four-item
comparison cannot approve this candidate. Mutation and Docs retain their earlier
fingerprints only because their complete compared signatures still match.

## Proposed bounded records

After independent semantic review and explicit acceptance, the coordinator may
add exactly these records to the corresponding packages' approved changes.
Until then, leave active configuration and accepted-decision evidence untouched.

```yaml
# @agent-teams/repository-mutation
- fingerprint: sha256:d9e941c4b83743f5785dc879e6e0161dd0e8e42dd31237c19c2805bdfff37be8
  decisionId: ADR-0054
# @agent-teams/document-authoring
- fingerprint: sha256:e0826ff1337a882ec8cb37f9445dd59444d2304d83ccaa398cd8680364c2b983
  decisionId: ADR-0054
# @agent-teams/docs-protocol
- fingerprint: sha256:827cd050444ab05940f024a174d78af44c902a7950c117fba68a900c83587def
  decisionId: ADR-0054
```

| Package | Typed entrypoints | Added / changed / removed | Required / declared bump |
| --- | ---: | ---: | --- |
| Repository Mutation | 7 | 128 / 5 / 0 | minor / minor |
| Document Authoring | 3 | 4 / 13 / 0 | minor / minor |
| Docs Protocol | 2 | 24 / 27 / 0 | minor / minor |

These are complete export-path-aware fingerprints, including every addition.
All packages remain below 1.0; existing minor Changesets suffice at the current
manifest versions. Preserve them. Release-owned versioning and baseline
promotion occur later through the existing validation-first procedure.

## Semantic dispositions and caller migration

Mutation's five reader callback members expand `typeof readBoundedRegularFile`
to the same two-argument Promise signature across `./node` and `./qualification`.
The old source imports the ordinary reader, not the separately exported fault
injector alias. Preserve callback substitution in both directions. Four new
subpaths (`./coordination`, `./known-file`, `./paths`, `./serialization`) are
additive portable mechanisms; retain every export and the existing root APIs.

Authoring's six V2/catalog/find function changes replace inline imports with
named public types. They reference the same public contracts; the compiler
closure below still propagates through V2 Plan parameters and producer results.
Six compiler/handler members across root and qualification deliberately close
native identities: historical Foundation compiler and handler strings are no
longer valid constructors for current Authoring contracts. Four added required
`kernelArtifact` members deliberately reject old kernel-less envelope objects.
Keep historical evidence intact and select its exact qualified external reader;
never manufacture a kernel coordinate or relabel an old journal.

The Authoring schema-ID union adds four owner-qualified identities while keeping
all old alternatives. Existing literal arguments remain accepted, but exhaustive
maps or consumers assuming a closed old result union need new cases. This is
an expanded vocabulary with a source impact, not proof of schema-byte equivalence.

Docs' envelope command/outcome/protocol spellings, recursive JSON and metadata
spellings, request intent projection and named receipt outcome preserve ordinary
structural callers. Keep named `DocsDiagnostic` interface augmentation and
readonly semantics. Optional `expectedPlanDigest` is additive: omitted means
explicit direct apply; selected preview apply must provide the reviewed digest.
Profile v4 is an explicit successor with consumer-owned blocker vocabulary;
v3 keeps its identity and semantics. Never pass a v4 object as a v3 profile.

`DocsNewResultV2` now includes the actual empty invalid-input result; its
qualification projection correspondingly makes `kind` optional. A previously
valid caller assigning every result's `kind` to `"new"` must narrow the result.
The `docsNewV2` signature inherits this change despite a declaration spelling
change. Do not restore an asserted discriminator merely to keep that caller green.

`docsRecoverV2` moves its result union inside `DocsExecutionV2`. Ordinary result
reads remain compatible, but an entire execution cannot be assigned to the old
union of executions. Adapt wrappers to the honest generic execution and narrow
its result. `DocsFindDocument` keeps its ordinary fields but no longer extends
Authoring's `DocumentDescriptor`: callers relying on inherited augmentation
must explicitly own that extension. Projected intent and metadata likewise stop
inheriting upstream interface augmentation. `interruptAndRecover` accepts old inputs,
but an old implementation requiring a mandatory-kind protocol cannot substitute
for the current helper. These are real source changes, not merely textual equivalence. Remaining function spellings preserve their input/output
shapes, subject to these referenced result and DTO changes.

## Evidence and admission limits

The review handoff contains exact released/current item inventories, source and
declaration hashes, all 45 changed-signature dispositions, additive inventories,
old-oracle authentication, compiler examples and exact proposed records.
Extraction uses API Extractor 7.58.12 and the existing comparator sequentially
for only these 12 affected typed entrypoints. This is no six-package artifact
or wildcard-member qualification claim; that inventory has a separate owner.

Focused tests in the existing Mutation and Authoring public-API owners prove
reader substitution and generation/identity contracts. The Docs public-type
owner checks structural spellings and concrete old-caller counterexamples for
empty results, nested recovery unions and upstream descriptor augmentation.
These finite compiler cases do not implement a universal compatibility solver.

The expected semantic gate result is three `breaking-change-not-approved`
diagnostics until this proposal is accepted through governance. Passing focused
compilation or changed/fast checks cannot grant that acceptance. Full verify,
independent final review, exact packed/registry evidence and each consumer's
migration admission remain separate gates; this proposal authorizes none of them.

## Boundaries and rollback

Retain the [accepted package ownership](0043-new-only-portable-documentation-package-boundary.md).
Consumer vocabulary stays data-only; portable packages acquire no managed or
business architecture dependency. Production, guard and schema code stay intact.
No historical reader, handler or support window is retired by this proposal.
Before publication this proposal and its focused tests can be reverted together;
restoring unsound declarations is not a valid fix. Published artifacts remain
immutable. Later correction requires a new release; consumer rollback requires
qualified `rollback_to`, exact owner/kernel artifacts and barrier inspection.
