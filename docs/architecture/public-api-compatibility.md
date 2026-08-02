# Public API Compatibility

Status: Accepted and implemented by ADR-0004. Consumer activation remains gated
on release-owned baseline mutation enforcement in that repository.

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
- a package version cannot move behind its released baseline;
- a breaking change also requires an exact SHA-256 fingerprint and an accepted
  ADR referenced by consumer configuration.

The fingerprint contains old and new signatures, kinds, parents, every addition,
and every removal in the same change set. Approval of one break cannot authorize
a different change to the same symbol or an extra additive export.

## Released baseline lifecycle

The baseline is released evidence, not an editable expected-output fixture.
Normal checks never write it. `public-api-promote-release` writes it atomically
per package only after every configured package validates, the manifest version
advances enough for the observed change, and any breaking fingerprint has an
accepted decision. A replay after a process failure skips an already-promoted
unchanged package and finishes the remaining packages. Same-version API drift
fails closed. Extractor-version changes fail and require an explicitly reviewed
migration.

Changesets invokes promotion after versioning. CI permits creation of a new
baseline during first adoption, but existing baselines can change only on
the same-repository `changeset-release/main` branch. Renaming or moving protected
baseline evidence is also a mutation. This prevents a feature pull request or a
same-named fork branch from rewriting both implementation and expected evidence.

The package comparison alone cannot prove who changed a Git file. A consumer
must therefore install an equivalent release-owned mutation check in required PR
CI before enabling this capability. Until Foundation exposes that check as a
reusable consumer command, the Foundation repository's own check is the donor
oracle and other consumers remain unqualified for activation.
