---
id: ADR-0060
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0060: Node 26 Cohort3 Projector Public API Evolution

Status: Accepted for the repository architecture coordinator within the
continuing Product owner Node 26 migration scope after independent Root review
of the MiMo-authored proposal and actual typed fingerprint/test logs.
Independent whole-code review and required CI remain before merge.

Decision owner: Product owner; the repository architecture coordinator records
this bounded decision.

Date: 2026-10-14

## Context

The reviewed implementation source checkpoint is
`e9e87457ab8ce95984e7c1fd2ca8a4e78f05e924` on
`fix/docs-gen3-cohort3-projector-20261014-a1`. It contains the Cohort3
qualification projector and the public managed registry canary default
generation routing as one coherent read-only vertical slice. At proposal time,
PR #391 remained at head `1adc468`; final source binding is established by the
external review and CI evidence, rather than a self-referential future ADR SHA.

API Extractor `7.58.12` compares released typed baseline `0.4.0` with the
Changesets candidate `0.5.0`. The exact observation is 265 canonical items
before, 342 after, 130 additions, one changed item, and no removals. The only
changed item widens `ConsumerIntegrationDesiredState` with the closed unselected
`ManagedSuccessorProfile`. The additions expose the Cohort3 request, evidence,
receipt, authority projection, and unselected Profile4/Cohort3 model needed by
the qualification entry points. Exporting
`ConsumerQualificationAuthorityV3` is required because the public
`DocsProtocolQualificationCohortV3Authority` alias references it; without that
export API Extractor rejects the qualification entry point with
`ae-forgotten-export`.

The exact current typed comparison classifies this bounded surface as breaking
and produces one fingerprint:
`sha256:e53b9871f0c72f61a0619db37826b879297e9aaf2c3c2105150768b731fba54a`.
The artifact inventory has no second reported breaking fingerprint. This
proposal does not alter or rederive the accepted ADR-0058 fingerprints
`sha256:d9af150a7c71fb7fa0172f1d51aa77d5eb8509977a90548b743a77a1c29afaea`
and
`sha256:b0bc159c7a8385393399623aaa98d80200bf93755030886b5b0fb4fddb18f79e`.

## Decision

1. Approve only
   `sha256:e53b9871f0c72f61a0619db37826b879297e9aaf2c3c2105150768b731fba54a`
   for `@agent-teams/docs-protocol-agent-teams`, referencing ADR-0060 through
   the existing public API compatibility mechanism.
2. Preserve the released `0.4.0` typed and artifact baselines unchanged. The
   existing `.changeset/docs-node26-policy-current.md` remains the sole `0.5.0`
   minor migration for this package.
3. Keep the public addition read-only. Cohort3 projection may validate a
   candidate and expose a qualification receipt, but it grants no central
   admission, lifecycle selection, consumer upgrade, release, or rollback
   authority.
4. Preserve ordinary Cohort1/Cohort2 public functions and rejection behavior,
   immutable old receipts and source history, and the unselected Profile4
   binding with `managedCandidate.selected: false` and status
   `candidate-unqualified`.
5. Route the public managed registry canary through the actual default
   projector. Generation3 requires one matching Cohort3 record, canonical
   record identity, packed current-policy identity, exact package provenance,
   and eligible canary repository state. Generation1/2 continue through their
   existing projector.

The new `NodeQualificationApiDependencies.projectCohortAuthority` is an
internal factory dependency, not a new graph owner or runtime service. All
existing factories and call sites must pass it alongside the retained
generation2 `projectAuthority`.

## Evidence and boundaries

The focused production-path test mocks network responses only. It runs the real
default projector against a closed Cohort3 registry fixture, validates the
projected binding with the retained
`schemas/qualified-docs-cohort/v3.schema.json`, and checks the actual packed
runtime policy remains unselected. Separate cases reject wrong generation,
record identity, packed policy source, and package provenance. A disposable
test copy restores the old generation2-only default wiring and is red on the
same Cohort3 network fixture while the current default is green.

Retained logs contain build/typecheck output, 60 passing focused tests with no
skips or failures, and the exact typed API diagnostic above. They do not prove
the remaining complete required gates or final GitHub matrix. The public API
gate must pass after acceptance; final source, independent whole-code review and
the complete final-head CI matrix are bound separately.

## Exclusions and rollback

Do not add Bridge B, a new service, an attestation or restoration framework, a
new schema family, automatic central admission, or a broad generation upgrade.
Do not edit accepted ADR-0058/ADR-0059 or released baselines. Before acceptance,
remove this proposal and its single proposed fingerprint entry as one bounded
unit if the final typed fingerprint differs or independent review rejects the
surface. After release, use a fix-forward release rather than rewriting public
or historical evidence.
