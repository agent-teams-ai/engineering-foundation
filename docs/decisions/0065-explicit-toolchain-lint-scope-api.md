---
id: ADR-0065
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0065: Explicit Stack Toolchain Lint Scope API

Status: Accepted by the repository architecture coordinator within the Product
owner-authorized explicit lint scope delivery, after independent architecture
review ADR_ACCEPT_GO. Required final gates and full CI remain separate.

Decision owner: Product owner; the repository architecture coordinator records
the bounded decision following independent review.

Date: 2026-10-22

## Context

The reviewed producer source is `1ab005d68da2f03474f2c8f5fb5884c1c0ec6167`,
with parent `34a3d453d98c9400c0231b65c109e7f00dca00d6`. Stack Toolchain
source remains version `0.0.0`; the existing minor Changeset prepares its initial
`0.1.0` release. This decision neither publishes that release nor approves its
package catalog entry, which remains candidate with null approval.

Native TypeScript 7.0.2 observes 43 baseline items and 46 candidate items:
three additions, four changed signatures, and no removals. The additions are the
public `LintScope` interface and its readonly `config: string` and
`paths: readonly string[]` members. Naming this type is necessary because the
public `ToolchainConfiguration.lint` property references it.

Three changed signatures only replace single quotes with double quotes:
`CommandInput.command`, `CommandReport.command` indexed access, and
`ToolchainConfiguration.profile`. Their TypeScript meanings are unchanged.
The fourth replaces the inline readonly `{config, paths}` lint object with
`LintScope & { readonly syntax?: LintScope }`. The optional syntax scope lets
consumers explicitly separate syntax-only paths from their typed lint scope.
The required existing fields retain their types; no field is removed or narrowed.
Old flat lint configurations remain structurally accepted in both directions.

The compatibility engine deliberately compares stored declaration signatures,
with only its existing trailing-generic-default exception. It conservatively
classifies these four signatures as breaking and reports exactly:
`sha256:7543fdd6717ebff41d39fae71faaa2cb9ce2811d7deaad99243cfa351294df36`.
ADR-0004 requires an accepted exact approval even for this declaration-compatible
0.x evolution. An unpublished source version does not bypass that rule.

## Decision

1. Approve only the fingerprint above for `stack-toolchain`, through
   `approvedBreakingChanges` referencing ADR-0065.
2. Keep the existing recorded typed baseline and compatibility algorithm unchanged.
3. Retain the existing minor Changeset; no additional bump is necessary.
4. Keep syntax lint explicitly configured. Do not infer consumer paths or weaken
   typed lint rules. Existing flat lint configurations need no migration.
5. Keep package catalog approval separate: fresh writer review must bind the
   actual package tree, not the historical approval removed by this delivery.

## Migration, evidence and limits

There is no source migration for existing `{lint: {config, paths}}` callers.
Consumers choosing the new lane add `lint.syntax: {config, paths}` explicitly.
No compatibility shim or compiler behavior change is needed.

The retained exact native item delta contains all four old/new signatures and
three added identities. The ordinary final-head gate passed the other ten
capabilities and rejected this exact unapproved fingerprint. Independent producer
review approved the package source and integration tree. These observations do
not claim final full CI, publication, or catalog admission. Those remain separate
required delivery gates after this decision is accepted.
