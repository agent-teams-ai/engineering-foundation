# Portable profile v4 compatibility and migration decision

Decision owner: Engineering Foundation repository, Docs Protocol feature owner.
Scope: the bounded portable-vocabulary hardening slice, 2026-09-05.
This is the repository-owned successor contract decision; accepted ADR history
and release-owned baselines are unchanged. Publication qualification is separate.

## Identity and compatibility

| Surface | Decision |
| --- | --- |
| Portable profile v3 | Preserve `$id` `https://agent-teams.ai/schemas/docs-protocol-profile/v3`, discriminator `schemaVersion: 3`, closed schema bytes, reader output and legacy vocabulary. |
| Portable profile v4 | New `$id` `https://agent-teams.ai/schemas/docs-protocol-profile/v4`, discriminator `schemaVersion: 4`; require `relations.blockers`. No implicit generation selection. |
| Authoring profile | Continue referencing Document Authoring profile v3 and `foundation-profile-v3-strict-merge`. |
| Protocol, command envelopes, Plans, Receipts, journals | Retain all existing wire identities and byte/digest rules. A protocol profile is not a transaction format. |
| Existing Node callers | `DocsNewRequest.expectedPlanDigest` is optional and source-compatible. `DocsProtocolProfileV3` stays unchanged. New `DocsProtocolProfileV4` is an additive type export. `DocsNewResultV2` now truthfully includes the existing empty wire error result; callers relying on a required `kind` without checking the result must narrow first. |
| Existing wire readers | V3-only readers reject v4. V4 is **not wire-compatible** with them. The new reader accepts both explicitly selected generations; no dual writer or automatic migration. |

Frozen schema and profile bytes plus original-parser outputs/diagnostics live in
`../tests/fixtures/profile-v3-frozen`. Provenance records the audited original
Git revision, not the interrupted checkpoint. This is a source compatibility
fixture, not a claim that bootstrap package version 0.0.0 was a supported release.
Registry artifact/SRI baseline promotion remains release-owner work.

## Data-only relation policy

```yaml
schemaVersion: 4
protocol: {id: agent-teams.docs-protocol, version: 1}
foundationProfile:
  path: .docs-protocol/document-authoring.yaml
  schemaVersion: 3
  metadataSidecarPolicy: foundation-profile-v3-strict-merge
agentWorkflow:
  adoption: portable-v1
  skillPath: .agents/skills/docs-authoring/SKILL.md
relations:
  blockers:
    types: [task]
    statuses: [todo]
    subjectIncompatibleStatuses: [done]
semanticValidatorIds: []
```

Each policy list has 1–256 distinct lower-case IDs (1–160 ASCII characters,
`[a-z0-9][a-z0-9._/-]*`), normalized into binary order. Types and statuses are
independent allowlists: a blocker must satisfy both. A subject with any blocker
cannot use a listed incompatible status. This vocabulary is consumer data;
it introduces no hooks, package loading, commands, or semantic-validator runtime.
The consumer's authoring profile and metadata schema must permit those same
values. No fixture is evidence of a second real consumer for extraction.

One document-relations policy governs preview, pre-Apply validation, and corpus
checking. Targets must exist in a complete catalog; self references and duplicate
IDs are invalid. New-document requests normalize binary order and include every
blocker in `related`; corpus checks require that inclusion in persisted metadata.

V3 keeps `open-decision`, statuses `deferred|open`, and subject exclusions
`accepted|active`. These compatibility values are selected only for v3. New
portable bootstrap writes v4 with types `adr|explanation|how-to|reference|tutorial`,
status `proposed`, and subject exclusions `accepted|active|deprecated|superseded`.
These are editable portable starter data, separate from managed Agent Teams
projection defaults. Existing v3 bootstrap trees are not rewritten by init.

## Portable paths

The existing `validatePortableRepositoryPath` keeps v3 acceptance.
`validatePortableRepositoryPathV2` retains its ASCII/NFC/length constraints and
uses Repository Mutation's existing portable-path check for device names and
trailing dots/spaces. V4 profile schema and pure reader agree on that intersection.
It rejects `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, ignoring
case and recognizing extensions, at every segment. It also rejects ordinary
segments ending in a dot. The v4 profile's own selected path is checked after
its generation is read. No existing v3 export or schema is silently tightened.
Authoring destinations and transaction paths retain their lower-layer authority.

## Reviewed creation

Supply the exact `new` preview's `planDigest` as `expectedPlanDigest` (CLI
`--apply --expect sha256:...`). It binds the compiled Document Plan's bytes,
authoring authority and effects. It does not hash the outer Docs Protocol profile.
Malformed digests or use during preview produce `invalid-input` (exit 2) before
planning; mismatches produce `authority-stale` (exit 1) before Apply. Both have
zero mutation effects. Direct `--apply` without `--expect` remains explicit and
compiles/applies current authority without claiming preview approval.

The request field is source-compatible; the widened error-result type is not a
blanket source-compatibility claim for result consumers. No wire shape changed.

After matching, current profile policy, authoring authority/catalog, required
anchors, cancellation, and lower-layer exact-preimage/barrier checks still apply.
Matching a digest never authorizes bypassing current policy or a later race.

## Migration and rollback

1. Finish or preserve any existing transaction using its exact recorded package
   version/build. Never reinterpret, rewrite, or clean up historical evidence.
2. Qualify the new reader on the consumer's existing v3 profile and metadata.
3. In one reviewed consumer change, select v4, add explicit blocker policy,
   replace nonportable paths if necessary, and align authoring metadata values.
   Do not infer this migration from installed package versions.
4. Review a fresh preview after migration and apply its digest. Run the consumer's
   required full documentation and architecture checks.

Before publication, the lane can be reverted as source. After publication,
artifacts remain immutable; fixes use a new exact release. A migrated repository
can restore its saved v3 profile only if its paths and document vocabulary satisfy
v3 and no incompatible transaction is pending. A package downgrade by itself is
not recovery. Managed profile/Cohort migrations remain the managed owner's work;
the exact projection contract is in this lane's coordinator handoff.
