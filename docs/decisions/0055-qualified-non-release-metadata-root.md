---
id: ADR-0055
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0055: Qualified Non-release Metadata Root

Status: Accepted by the orchestrator and owner authorization for frozen S3

Date: 2026-09-20

Decision owner: Product owner

## Context

The workspace root participates in inventory and topology even when it only
owns repository metadata. Requiring a package archive and a release baseline
for that root conflates topology with release obligations. Inferring an
exemption from `private: true` or absent exports would permit scope shrinkage.

## Decision

Introduce the smallest authority successor, protocol v3, and C0 boundary
revision 6. Preserve the prior C0 bytes, published schemas, v5 observation and
report vocabulary, and all release baselines. The root remains governed in
inventory, source identity, transitions and report coverage. Only its release
role may become `non-release-metadata-root`.

The consumer owns the closed classification record. Trusted composition must
authenticate the approving owner, exact evidence digest, authorization,
approval, request and retained history. EF independently checks the exact
committed regular files at both source commits/trees and the working bytes.
The root must remain at `.` with `package.json`, the same package name,
`private: true`, no exposure keys, identical workspace bytes and identical
classification bytes. Candidate self-declaration never supplies authority.

A qualified root may omit archive and release-baseline rows. Every other
member of the trusted-base/candidate union and every surviving historical
release obligation remains covered. Existing release evidence conflicts with
the non-release claim. Unknown or reclassified roots, exposure, removal,
rename, workspace-glob changes, omitted/substituted evidence and installed-byte
drift fail closed. There is no root export resolution, general no-exports
semantics, wildcard exemption or automatic private-package exemption.

## Consequences and evidence

Authority protocol v3 rejects prior protocol versions and adds one bounded
metadata-root proof to the request-bound evidence manifest. Package archive
observations remain single-package. Root evidence never qualifies a package;
archive evidence never qualifies a root. Archive identity, installed bytes and
topology have independent checks. Promotion fences source identity after
asynchronous completion and immediately before baseline writes; drift permits
no writes. The production deadline remains 120 seconds.

The [C0 boundary](../reference/sdk-growth-c0.md#revision-6-qualified-non-release-metadata-root)
and [S3 contract](../reference/sdk-growth-s3-authority.md#qualified-metadata-root)
define the exact fields. Focused rejecting tests and the disposable packed
installed check/promotion fixture exercise this decision. External ReviewRouter
deployment, required-status publication, consumer activation and real user
projects are outside this authorization.
