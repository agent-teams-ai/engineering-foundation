---
id: ADR-0066
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0066: Qualified Existing npm Bootstrap Recovery

Status: Accepted recovery design; implementation review, required full CI and
protected execution pending. Decision owner: Product owner. Date: 2026-10-22.
Acceptance is recorded by the repository coordinator under the authorized delivery,
after independent plan and documentation review.

## Context and retained evidence

Canonical bootstrap [run 39774275653, attempt 1](https://github.com/agent-teams-ai/engineering-foundation/actions/runs/39774275653/attempts/1)
returned npm publish exit zero for `stack-toolchain@0.0.0` from
`67ccfb359fa2112e7a3554576391d4369477f937`. Its immediate install/audit failed
while npm processed the package. Later unchanged install, signature audit and
original-source binding passed; invalid/missing sets were empty and registry
bytes matched the approved tree/SRI. This is not whole-bootstrap success:
deprecation remained absent, and strict guards rejected the additional version.

npm documents a public `0.0.0-stage` placeholder when creating a package through
[staged publishing](https://docs.npmjs.com/staged-publishing/); its
[new-package support announcement](https://github.blog/changelog/2026-10-02-npm-staged-publishing-now-supports-creating-new-packages/)
does not authenticate any particular registry object. The retained Stack
placeholder has the reviewed SRI
`sha512-17gDGy/D3GbqsDUbYAhwkmr0/tdMLnbAa5fJwjOHzjBp/iM9FhVZKJu472MrQ0UCH3ziEg6oELCLTAW2r5BoVA==`.
Flags or version spelling alone cannot establish provider origin.

Retained reconciliation: `bootstrap-operator/attempt-67cc-20261022/postpublish-readonly-reconcile-39774275653/reconciliation.json`,
SHA-256 `88cc4691634d49856cc9454d1baf8e1c6323411433ebaefb0760cde84832e24c`;
original-source binding SHA-256
`c0bed38d59617070f1416897a236ebd302ab747a457826855125ee554a1c9e78`.
The prior token was revoked, secret removed, activation disabled, and local
bootstrap credential/account session removed. None is recovery authority.

## Decision

This is a scoped successor to ADR-0044's extra-version and same-source reuse
rules. Its other requirements and ADR-0040's retained invariants continue;
whole-document supersession stays empty and accepted historical bytes remain
unchanged. No package boundary, module graph, public API or framework is added.

1. The existing Foundation release-policy owner supplies one strict shared
   history classifier to bootstrap and ordinary release. Before reducing full
   records to version/tag lists, qualify the catalog-pinned placeholder's exact
   name, version, `_id`, `stub`, description and dist association, then its exact
   SRI and bounded canonical archive. Admit only the `package` root directory
   and two regular files, `package.json` and `README.md`, with the reviewed
   bytes. This exact pinned archive expands to 2,560 bytes with complete members
   but no tar end blocks. Verify its original SRI before bounded gunzip (16 KiB,
   512-byte alignment); append two zero end blocks only to an inspection copy for
   the unchanged strict codec. Require all complete extents inside the original
   bytes and their maximum end exactly at the original length. Never persist,
   publish or identify the synthetic view as the artifact; this catalog-specific
   adapter grants no generic missing-end-block tolerance.
   Reject duplicate/special/additional members, trailing content, runtime
   fields, changed bytes, malformed records, tags targeting the stub and unknown
   versions. This placeholder is neither a baseline nor a supported release.
   The separate accepted CI Input Proof predecessor exception stays unchanged.
2. The closed catalog pins `providerPlaceholder: {version, archiveIntegrity}`
   and `recovery: {sourceCommit, runId, runAttempt}` for Stack's original source
   commit above, run `39774275653`, attempt `1`, and existing approved tree/SRI.
   Require the same signed SLSA invocation URL as that original
   attempt, alongside verified package subject/SRI, repository, workflow, ref and
   source commit. Metadata and a successful unsigned receipt cannot substitute.
3. Current execution has separate authority: the new protected-main checkout,
   fresh green required main CI, current-main fences, short token window and
   environment review still apply. The current run does not become the artifact
   source. The existing `bootstrap` operation derives `existing-artifact-only`
   mode from the catalog; no user-selected recovery switch grants authority.
   Structurally prohibit packing, publishing and absent-version fallback. Retain
   Node projection installation and only the verifier build
   `pnpm --filter @agent-teams/engineering-foundation build` for its codec;
   do not run the full package build/pack path. Missing or conflicting bytes stop.
4. Observe availability first under a 180-second elapsed budget with five-second
   polling; response headers and bodies share the remaining deadline. Then run
   bounded install/signature audit
   with 120-second subprocess limits. An uncertain result permits read-only
   observation only; no timeout or missing version authorizes another publish.
5. Only after complete immutable/archive/signature/source/invocation proof may
   recovery perform the existing exact guarded deprecation and recheck all
   postconditions. Reconcile the Git tag and prerelease at the **original** source
   commit while GitHub write authority remains the **current** main commit.
   Both bootstrap and ordinary reconciliation validate scoped and unscoped
   package tags. Never move npm tags, delete versions or waive history checks.
6. At every attempt's terminal state, including failure, immediately revoke the
   fresh token, delete the secret and disable activation before investigation or
   Trusted Publisher setup. Only after complete canonical proof may a separate
   interactive Trusted Publisher setup proceed. The supported `0.1.0` remains
   the ordinary Changesets/OIDC release, with its own qualification. Neither
   placeholder nor `0.0.0` becomes supported through this decision.

## Verification and limits

Require rejecting cases for every placeholder identity/archive/tag drift,
missing or changed real artifact, wrong signed invocation and current/source
confusion; prove recovery cannot call pack/publish, including the absent case.
Preserve install/audit, minimal-build, deadline, unscoped-tag and ordinary-release
regressions. Independent final review and required exact-head/full native CI
precede protected recovery. This ADR and read-only reconciliation do not claim
recovery execution, deprecation, GitHub reconciliation or release completion.
