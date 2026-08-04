# Public API Compatibility

Status: Accepted and implemented by ADR-0004. Consumer activation remains gated
on release-owned baseline mutation enforcement in that repository.

`package.public-api-compatibility` compares built declaration entry points with
a committed snapshot of the last released TypeScript API. API Extractor is an
outbound adapter; its model types do not cross into capability policy.

Configuration schema `v1` retains the original single declaration entry point,
baseline shape, and `decisionPath` approval contract. Its trust boundary is
hardened: the released baseline must use the stable package anchor, and raw ADR
Markdown is no longer sufficient approval evidence. When a legacy `v1` policy
declares an approval, omitted evidence paths resolve to the stable governance
anchors. Schema `v2` supports all public export paths of one package and uses
stable `decisionId` approvals:

```yaml
schemaVersion: 2
acceptedDecisionBaselinePath: architecture/decisions/accepted-decisions.json
packages:
  - packageName: "@agent-teams/engineering-foundation"
    entrypoints:
      - exportPath: "."
        declarationEntryPoint: packages/engineering-foundation/dist/index.d.ts
      - exportPath: "./local-mode"
        declarationEntryPoint: packages/engineering-foundation/dist/local-mode/index.d.ts
    nonTypeExports:
      - exportPath: "./package.json"
        kind: data
      - exportPath: "./schemas/*"
        kind: wildcard
```

Each `v2` snapshot stores an independently ordered surface for every
`exportPath`. The same API Extractor canonical reference is therefore allowed
in two paths without being merged. A root namespace export such as
`export * as localMode ...` is an additional root API, not a substitute for
checking the independently importable `./local-mode` path.

`v2` is closed over the normalized `package.json.exports` map. Every public
typed subpath must appear exactly once in `entrypoints` and its declaration path
must match the package's `types` target. `data`, `wildcard`, and untyped
`runtime` exports must instead be named exactly once in `nonTypeExports`; a
typed wildcard is rejected until its concrete subpaths can be baselined. This
prevents a newly exported path from bypassing compatibility evidence.

## Compatibility policy

- a new top-level export is additive and requires a minor Changeset;
- removing or changing an existing item is breaking;
- adding a member beneath an already released class, interface, or namespace is
  conservatively breaking;
- before `1.0.0`, breaking changes require a minor bump; after `1.0.0`, a major
  bump is required;
- a package version cannot move behind its released baseline;
- a breaking change also requires an exact SHA-256 fingerprint and an approval
  reference to a currently accepted ADR whose identity and immutable path are
  verified against the accepted-decision baseline (`decisionPath` in `v1`,
  `decisionId` in `v2`);
- raw ADR Markdown, including `Status: Accepted`, is not approval evidence.

The fingerprint contains old and new signatures, kinds, parents, every addition,
and every removal in the same change set. Approval of one break cannot authorize
a different change to the same symbol or an extra additive export.
API Extractor namespace items have no declaration excerpt, so the adapter records
the deterministic signature `namespace <displayName>`; every other empty
declared-item signature fails closed.

For `v2`, a breaking fingerprint also includes the export path and any added or
removed export path. Reordering configuration or snapshot entrypoints cannot
change the comparison result. A removed export path is breaking even when its
surface is empty; an added path is additive unless another change in the same
release is breaking.

## Released baseline lifecycle

The baseline is released evidence, not an editable expected-output fixture.
Normal checks never write it. `public-api-promote-release` writes it atomically
per package only after every configured package validates, the manifest version
advances enough for the observed change, and any breaking fingerprint has an
accepted decision. A replay after a process failure skips an already-promoted
unchanged package and finishes the remaining packages. Same-version API drift
fails closed. Extractor-version changes fail and require an explicitly reviewed
migration.

The accepted-decision baseline is consumed through a narrow public-API-owned
evidence port. Its governance-specific schema and lifecycle are translated by
an outbound ACL; public API policy imports neither governance domain types nor
raw ADR documents.

Each package has one deterministic release-owned baseline anchor:
`architecture/public-api/<package-local-name>.json`. The policy's
`releasedBaselinePath` must equal that anchor; it is not an arbitrary pointer.
For schema `v2`, that one baseline contains every public export path. This blocks
a pull request from redirecting compatibility checks to a newly created or stale
snapshot. Duplicate anchors are rejected, and the repository release gate still
protects creation, replacement, movement, and deletion under
`architecture/public-api/`.

Moving a consumer from `v1` to `v2` is a release-owned adoption. On the trusted
release path, change the policy to `v2` and run `public-api-promote-release`;
the command writes a complete `v2` baseline only when the previously governed
root API is unchanged. A root change must be released under `v1` first. Normal
checks never accept a `v1` baseline as `v2` evidence, and no feature PR may
silently reset the baseline pointer.

### Upgrading an existing v1 consumer

This pre-1.0 hardening requires a one-time release-owned migration when a `v1`
consumer used a different baseline path or raw ADR approval evidence:

1. on a trusted release branch, move the existing baseline bytes without
   regenerating them to `architecture/public-api/<package-local-name>.json` and
   update `releasedBaselinePath`;
2. declare `governance.architecture-decisions`, create its stable configuration,
   and promote the immutable accepted-decision baseline before relying on an
   existing `decisionPath` approval;
3. run the complete Foundation and consumer checks before promotion. A changed
   API fingerprint or an ADR absent from accepted immutable evidence still fails
   closed.

Do not restore a raw-Markdown fallback or generate a fresh API baseline merely
to make the upgrade pass. Either action would discard the released evidence the
capability is intended to protect.

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
