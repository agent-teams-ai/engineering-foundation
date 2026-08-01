# Public API Compatibility

Status: Implemented; ADR-0004 is proposed.

`package.public-api-compatibility` compares a built declaration entry point
with a committed snapshot of the last released TypeScript API. API Extractor is
an outbound adapter; its model types do not cross into capability policy.

## Compatibility policy

- a new top-level export is additive and requires a minor Changeset;
- removing or changing an existing item is breaking;
- adding a member beneath an already released class, interface, or namespace is
  conservatively breaking;
- before `1.0.0`, breaking changes require a minor bump; after `1.0.0`, a major
  bump is required;
- a breaking change also requires an exact SHA-256 fingerprint and an accepted
  ADR referenced by consumer configuration.

The fingerprint contains old and new signatures, kinds, parents, additions, and
removals. Approval of one break cannot authorize a different change to the same
symbol.

## Released baseline lifecycle

The baseline is released evidence, not an editable expected-output fixture.
Normal checks never write it. `public-api-promote-release` writes it atomically
only after the manifest version advances enough for the observed change and any
breaking fingerprint has an accepted decision. Extractor-version changes fail
and require an explicitly reviewed migration.

Changesets invokes promotion after versioning. CI permits creation of a new
baseline during first adoption, but existing baselines can change only on
`changeset-release/main`. This prevents a feature pull request from rewriting
both implementation and expected evidence.
