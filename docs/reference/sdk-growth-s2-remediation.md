# S2 frozen-contract remediation evidence

This patch starts at `de77f14070cfff071fc69706cd725fb90a8d91f3`. The
[frozen C0 contract](sdk-growth-c0.md) remains byte-identical. Neither v1 schema
bytes nor the v1 mapper change. S3 authority and consumer activation remain
unqualified.

## Configuration and execution

The exported v2 object uses exactly `contractRevision`, `policyVersion`,
`comparison`, `decisionsPath` and `reportPath` under `sdkGrowth`. Governance is
required. Invocation, authority, workspace and publication-preimage selectors
are rejected. The original v1 package definition is retained.

Configuration rejects overlapping report paths, including ancestors and
children of input paths, governance roots/index, accepted baselines, lockfiles
and governed package roots. Composition also checks the discovered workspace
roots and destination file/parents before extraction. Publication must repeat
its containment and fencing checks; early validation cannot replace them.

Composition reads the actual Git checkpoint, workspace/manifests, lockfile and
package build inputs. Package trees are bounded to 4,096 files and 32 MiB;
`node_modules` and `.git` are outside that package-input tree. Source changes
and uncommitted package inputs prevent checkpoint binding. The checker identity
hashes its installed `package.json`, `dist` and `schemas` files. The toolchain
identity includes the actual Node and extractor versions and the lock digest.
These are observed build-directory identities, not tarball provenance or
trusted build attestations. Input identity is reread before publication; a
changed invocation is an invariant failure. Workspace inventory is retained
once for the S1 observer rather than enumerated by a second SDK observer.

## Report

The separate artifact projects observation references rather than exposing the
internal compatibility handoff. It contains the frozen revisions, authority,
coverage, both comparisons, transition receipts and seven ordered phases.
Projection combines trusted-base and candidate coverage; it does not alter S1
observations. The entire closed report is validated and normalized before
canonical serialization. Incomplete and rejected results carry no receipts.
Only a complete admitted execution with verified workflow/run references can
produce a whole-set receipt. Existing release compatibility must independently
pass before release eligibility.

The existing filesystem context does not provide released growth aggregates or
verified workflow/run references. Their absence stays explicit and incomplete;
v1 snapshots are not converted into invented growth observations. Optional
internal retained evidence enables projection when a qualified context actually
provides those facts. This does not activate S3 or grant authority to config.
Canonical artifact diagnostics use the exact report path, digest and contract
revision evidence kinds. Semantic admission diagnostics remain on the existing
capability report rather than adding fields to the closed growth artifact.

## Schema-release evidence

[The dedicated capability configuration](../../architecture/foundation/sdk-growth-json-schema-releases.json)
selects this family without replacing the existing docs-profile family.
Its initial [release-owned baseline](../../architecture/contracts/json-schema/package-public-api-compatibility-v2.json)
is release preparation for these new v2 bytes, not evidence of registry
publication. The governed corpus contains both released and initial-unreleased
configurations and rejects missing frozen fields, candidate authority/invocation,
mixed branches and malformed paths. The existing `contract.json-schema-releases`
capability runs against this configuration in the schema-corpus test.

[Consumer evidence](../../architecture/contracts/sdk-growth-v2/consumer-evidence.json)
is explicitly a local fixture of the built configuration loader. It binds the corpus, schema set and test source. It does
not claim an external consumer, archive qualification, accepted owner decision,
release publication or S3 authority. The first-surface decision remains an
unverified proposal; refreshing its exact transition bytes is not approval.
Packed qualification must be rerun after the packed fixture is migrated to the
closed report/configuration, before claiming that delivery gate passed.

## Frozen-byte ambiguities

C0 defines observation and transition digest domains exactly, but does not fix
an encoding/domain for the complete per-package released observation set.
This implementation hashes the canonical normalized aggregate array in released
package order and the singleton candidate aggregate array. An initial-unreleased
row binds its package name, branch and verified history evidence instead of an
invented released observation. Available history from the trusted context permits
an empty comparison side; unavailable history retains its branch and stays
incomplete. No derived empty side is projected as a released ObservationRef. It preserves the
specified atomic transition hashing. This interpretation needs review alongside
the frozen bytes; no change is made to C0's identity sidecar.

C0 also gives invocation digest fields without prescribing discovery of a
local build or exact tarball from the existing command arguments. The explicit
build-directory interpretation above reports actual selected bytes and leaves
packed coverage unavailable. It must not be described as tarball integrity or
immutable CI custody.
