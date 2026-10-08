---
id: ADR-0057
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0057: CI Input Proof Leaf Type Contract

Date: 2026-10-08

Decision owner: Repository architecture coordinator, within the owner-authorized
bounded CI Input Proof hardening. Acceptance approves this exact type correction,
not an independent review or release.

## Decision

Narrow public `InputLeaf` to a readonly discriminated type/mode union: file pairs
with `100644` or `100755`, symlink with `120000`, and gitlink with `160000`.
The previous type admitted invalid pairs that the runtime already rejects.
Keep comparator `unknown` parameters, validation, results and authority unchanged.
The package remains a fixed static dependency, without a new composition node.

Approve only breaking fingerprint
`sha256:779147090ac75f16946d44f6c865574e0bd35be7a302d1e51c9180b21c68ce01`.
Retain release-owned API and prior accepted decision baselines unchanged.

## Migration and evidence

Consumers construct valid literal pairs or narrow the `type` discriminant before
assigning `mode`; broad assertions do not replace validation. The existing minor
Changeset carries this breaking 0.x migration with README/changelog guidance.
The installed public-root type probe must accept all valid variants and reject
mismatched file/symlink/gitlink modes; runtime and deep-import checks remain.
This decision authorizes no publication, new omission policy or wider trust claim.
