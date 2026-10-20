# Release Checks source admission

`@agent-teams/release-checks` is an independent development library admitted by
[ADR-0063](../decisions/0063-release-checks-package-admission.md) under
[ADR-0061](../decisions/0061-library-first-foundation-boundary-evolution.md).
The [accepted delivery plan](release-checks-delivery-plan.md) and
[review record](../research/release-checks-plan-review.md) retain the completed
I1-I3 and C1-C3 rounds. This note distinguishes source work from publication
and consumer adoption. The [implementation qualification record](../research/release-checks-implementation-review.md)
tracks concrete code corrections, executed checks and final delivery evidence.

## Contract and owners

The public root exports `checkReleaseCandidate` and its concrete types. The
deliberate `./conformance` entry exports shared data with independent expected
outcomes, diagnostic codes and package changes. Both entries are pure, bounded
and deterministic. The package has no runtime, peer or optional dependency.
Its sole development dependency is the repository-catalog TypeScript compiler,
reusing existing exact clean-stage compiler custody; installed consumers get
no transitive compiler or parser. It introduces no Foundation root
facade, capability or consumer runtime dependency.

The package checks normalized accepted inputs against observed output. It
validates complete package and intention relationships, exact engine-planned
versions, full version-only manifests and the classified complete diff. It
does not generate a plan, choose a version, infer dependency rewrites, read a
repository, authenticate facts or authorize effects.

Foundation's existing release Hosts retain source and engine custody, official
Changesets collection, independent candidate reads, prerelease bookkeeping,
changelog and API policy, locks and publication. Its source-built adapter
replaces the transferred pure comparisons; it does not wrap and retain their
duplicate implementation. Get Modular and node-or-bun own their adapters and
adopt exact supported coordinates only after registry proof.

## Admission and qualification evidence

| Claim | Status and authority |
| --- | --- |
| Plan accepted before implementation | Completed I1-I3 and C1-C3, retained review record |
| Actual pinned engine behavior | P0 qualified 14 disposable fixtures with Changesets 2.31.1/3.0.2; report digest retained in the review record |
| Pure source and common fixtures | Implemented in one `candidate-checking` feature; focused tests must qualify the final source |
| Real Foundation consumer | Source-built release Hosts adopt the contract; final-head Host conformance and tamper checks remain required |
| Packed installed consumer | Focused actual qualification passed: two independent clean-stage builds produced identical archives; the installed pnpm consumer passed native TypeScript 7.0.2 and all 10 common runtime cases through both public entries |
| Hermetic registry consumer | The same qualified archive was published only to disposable no-uplink Verdaccio and installed by exact version with npm; public typing and all 10 runtime cases passed with matching archive integrity. Existing `npm-foundation` qualification invokes the same probe |
| Complete inventories | Catalog, strict projects, source/feature/quality profiles and complete Linux/Windows/coverage inventories include the package and tests |
| Initial typed baseline | Existing native promotion owner created only `release-checks.json` at `0.0.0`; the complete nine-package typed and artifact checks passed and all 13 historical baseline files retained their exact hashes |
| Namespace bootstrap | Candidate only, `approval: null`; no bootstrap or publication is authorized by admission |
| Supported release and external consumers | Pending exact protected publication, registry readback and separate installed consumer evidence |

The retained [installed qualification report](../research/evidence/release-checks/p1-installed-qualification.json)
has SHA-256
`a1e2b20a039b89a92d0054244a88bb8f5817201d23cdb2394bf502866e95eaf3`.
It records the actual Node 26.11.1 run and qualified archive SHA-256
`5c468f1721ceb04d1c909b0c6c2fc42167496f7e60703fea0dfc0a094a14fdd7`.
The installed lock closures contain only release-checks, proving that the
development compiler is not installed transitively. Both public runtime
exports, package identity, exact version, native declaration consumption and
blocked private deep imports are checked. This is focused source-artifact
qualification; it is not final-head full CI, public npm publication or external
Host adoption evidence.

The P0 engine evidence preserves actual direct/dependent intent links and exact
versions. Both engines retain GM's symbolic `workspace:*` and `workspace:^`
manifest strings, but produce different peer-dependent versions. The existing
FMS `workspace:^1.8.0` floor survives an in-range Foundation release; an actual
Foundation major rewrites the peer and is outside the version-only admission.
Explicit `none` records need no edit. Ignored/private intention membership does
not imply consumption. A real mixed release consumes its qualified empty
housekeeping files while retaining ignored and non-versioned private files.
No-release Hosts stop before version generation.

The [initial API evidence](../research/evidence/release-checks/p1-initial-api-baseline.json)
records the actual create-only write and subsequent complete nine-package
compatibility check. The production configuration was not reduced or edited
for generation. The write target was only the new initial anchor, derived from
that configuration, and the existing promoter enforced the initial `0.0.0`
manifest, minor Changeset and absent preimage. The new baseline SHA-256 is
`9b02f3b4860b8f9f39eaf175d37c49c0e1678f492aea620d0e6053120b37e414`.
The normal all-package release promoter cannot run before versioning the
preexisting Repository Mutation API addition: its pending minor intent is
`.changeset/atomic-adr-baseline-replacement.md`. That existing same-version
rejection was preserved. No old baseline or unrelated manifest was advanced
to create the new initial anchor.

## Source and publication hold

The source manifest begins at `0.0.0` and a minor Changeset lets the existing
engine derive supported `0.1.0`. This is not an npm publication. The public
catalog and candidate bootstrap entry intentionally block **all ordinary
Foundation publication** until the existing bootstrap completes.

Pre-merge npm provider readiness remains unresolved: the required interactive
account surface was blocked by Cloudflare during the accepted preflight.
Finish source, review and CI work, but keep public admission unmerged until
that existing readiness requirement is established. Do not enable bootstrap,
create a timed token, enter approval identities or relax the release hold to
work around the access limitation.

P3 uses the existing protected namespace workflow, exact main/full-CI proof,
reviewed writer archive SRI and package tree, one-package short-lived token,
signature/provenance/deprecation readback and cleanup. Only after its immutable
deprecated `0.0.0` baseline exists may the normal Changesets owner-PR flow
publish supported `0.1.0`. The supported artifact then needs exact public
registry and installed-consumer qualification before external adoption.
