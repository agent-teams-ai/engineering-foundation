# SDK growth S3 trusted authority integration

Engineering Foundation exposes the opt-in
`@agent-teams/engineering-foundation/sdk-growth-authority` entrypoint for a
trusted host such as ReviewRouter. The entrypoint is an EF port and adapter
boundary. It does not implement ReviewRouter authentication, persistence,
workflow dispatch, status publication, or consumer activation.

The ordinary `foundation:check` route remains unchanged. Its filesystem context
rejects embedded verified claims and cannot produce trusted authority. The S3
entrypoint accepts an executable transport only through trusted host composition;
consumer configuration cannot select a transport or load a plugin.

## Bound execution

The closed `reviewrouter:sdk-growth-authority:3` request binds the provider
repository ID, pull request, head, base, merge base, exact evaluation source,
verifier revision, Foundation archive and installed distribution identities,
extractor, lock and build invocation, policy, command, scope, enrollment,
history, and evidence manifest. EF recomputes the local invocation, policy bytes,
scope, command and report identities. The authority adapter requires exact grant
agreement before it injects trusted context through the existing
`GrowthInputContextPort`.

Candidate decisions remain proposals. Authenticated owner evidence binds the
complete normalized Decision digest. Candidate historical files are parsed by
the existing rejecting boundary, but grant no authority. Trusted release and
history content comes from the host grant and must match the configured package
set and exact archive evidence.

Authority does not change surface semantics. Unsupported or unavailable
coverage remains incomplete, all seven phases retain their frozen order, and a
qualified initial-unreleased record waives only nonexistent published
compatibility obligations. It does not create a v1 baseline or waive
first-surface admission. The trusted assembly selects candidate observations
through `GrowthObservationPort`, after resolving authenticated custody. Admission
retains that S1 payload unchanged; context data cannot replace its entries or
coverage. The adapter checks overlap against local compatibility observations
and cannot use archive-only API digests as declaration or artifact snapshots.
Decision qualification is projected separately into report coverage.

The host supplies the clock through the verifier constructor. Missing clocks
fail closed; composition does not import a different feature's time adapter.
Packed fixtures use the same controlled clock for grant issuance, expiry,
receipt issuance and verification.

## Qualified metadata root

[ADR-0055](../decisions/0055-qualified-non-release-metadata-root.md) and
[C0 boundary revision 6](sdk-growth-c0.md#revision-6-qualified-non-release-metadata-root)
separate topology from release obligations. The closed v3 grant requires
`metadataRoots` (empty or one record). Each record carries `evidence`, its
`evidenceDigest`, and authenticated `ownerEvidence`. The evidence digest uses
`foundation:sdk-growth:metadata-root:1` over `{ domain, evidence }`. Evidence
contains kind, packageName, rootPath, manifestPath, classificationPath,
historyDigest and two exact source records (`base`, `candidate`), each containing
`source`, `manifestBytes`, `workspaceBytes`, `classificationBytes`. Owner evidence
uses the same closed owner fields as decision authentication; its decisionDigest
is the metadata evidence digest and its sourceBindingDigest is the exact request
digest. The classification bytes bind decisionId and ownerRef independently.

The consumer's canonical classification JSON declares schemaVersion, kind,
packageName, rootPath, manifestPath, decisionId, ownerRef, and releaseHistory.
Only `foundation:sdk-growth:metadata-root:1`, `non-release-metadata-root`, `.`,
`package.json` and `none`, respectively, are accepted for the closed literals.
EF reads Git objects for the regular source files at both commits, checks their
trees and exact bytes, and checks the candidate working files. Missing source
objects, links, changed classifications or workspace bytes fail closed.

This proof qualifies only the root's release role. The root remains governed in
the full topology and has report coverage with the explicit reason
`qualified-non-release-metadata-root`. Complete packed coverage for that root
means its authenticated non-release obligation is satisfied; it does not claim
an archive exists. Package evidence stays single-package, with independently
checked archive identity, installed bytes and local topology. The release scope
is the full trusted-base/candidate union minus only that qualified root; it may
never discard a historical release obligation. Missing proof leaves the root
subject to the existing fail-closed requirements.

Versions 1 and 2 are rejected, not reinterpreted. No published schema, historical
baseline, archive format or v5 observation coordinate is changed.

## Acyclic custody

Digests follow one direction:

```text
request -> grant -> finalized EF report -> completion -> final receipt
```

Each object has its own domain. The report's existing `receiptDigest` contains
the input grant digest. The final receipt binds the completion and finalized
report; EF never rewrites the report with that later receipt. A promotion plan
binds destination, operation, exact preimage and proposed bytes before its
authorizing completion, so it introduces no digest cycle.

### Canonical archive evidence

Custody uses one `foundation:sdk-growth:archive:1` representation: canonical
JSON with `schemaVersion` and `files`, ordered by normalized package-relative
path. Each file contains `path` and lowercase `contentHex` encoding its exact
bytes. Archive SHA-256 and SHA-512 integrity identify this canonical payload,
not compressed transport bytes. Manifest and installed inventory digests hash
the decoded file bytes. EF derives the archive manifest from those bytes and
requires a root `package.json` with matching `name` and `version`. Missing, malformed or unrelated
package metadata fails closed, even when all producer digests are recomputed.
Paths use the same lowercase canonical identity for equality and ancestry;
backslash separators and noncanonical paths are rejected on every platform.

The trusted host supplies `createSdkGrowthAuthorityVerifier(transport,
installedInventory, now)` with an explicit host clock (`() => Date`) and a separate `GrowthInstalledInventoryReader`. Its
`read(identity, cancellation)` observes every regular file of the independently
installed package selected by immutable archive identity, rejects links and
special files, and returns package-relative paths and raw `Uint8Array` bytes.
It receives no producer payload or inventory. EF hashes these observed bytes
and requires exact equality with the archive manifest; missing readers, missing
files, extra files and changed bytes fail closed. The wire `installedFiles`
claim is also checked but cannot substitute for this observation. Transport
archive integrity remains the installing host's concern.

The custody digest covers that canonical evidence. The bound evidence manifest
uses domain `foundation:sdk-growth:evidence-manifest:2` and a payload containing
sorted `archives` and `candidates` rows (`packageName`, `custodyEvidenceDigest`),
`metadataRoots` rows (`packageName`, `evidenceDigest`),
and `retainedHistory` (the historical custody digest). This request-bound anchor
prevents substitution even if all replacement custody claims are rehashed.
Historical custody must contain `trusted-base.json` with the canonical normalized
trusted-base observation bytes, and its retained digest must match.

Promotion carries the prior check grant and finalized completion in the nested
check receipt's `provenance`. EF recomputes their digests, checks their identifiers
and all receipt bindings, and relates the grant to the finalized report's
existing authority digest. A prior grant is validated at receipt issuance time;
the current promotion grant must still be live.

## Promotion

Authority protocol v3 promotion exists only
on the trusted entrypoint and requires an authenticated qualified check receipt
for the same binding and finalized admitted report. EF then runs the existing
typed and artifact compatibility, SemVer and decision preflight, captures every
write in one promotion plan, obtains a qualified receipt for that exact plan,
rereads invocation identity, and applies the writes with exact preimage checks.
Any mismatched receipt or destination prevents every write. Exact already-applied
outputs remain replayable; changed preimages fail closed.

This integration does not claim external ReviewRouter publication or a positive
activation result. Real activation still requires ReviewRouter-controlled
custody, exact qualified archives, complete supported coverage, current target
verification, and an externally controlled required status producer.
