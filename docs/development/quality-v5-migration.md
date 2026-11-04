# Migrate quality coverage to v5

Foundation 4 replaces the current quality source-coverage runtime with v5.
Consumers on an earlier major can keep their pinned package and existing v1–v4
profile until they can migrate. Historical schemas remain exported with unchanged
bytes; their availability does not imply that a new major executes old profiles.

This guide describes the candidate major contract. Select an exact published
Foundation 4 version after its ordinary release qualification; a source merge or
successful test does not itself mean a version has been published.

## Required changes

1. Keep existing source ownership, suppression policy, protected lint rules,
   native/asset gates and bridge evidence. They remain authoritative.
2. Put the existing production compiler-project list in the consumer-owned Stack
   Toolchain configuration at `typecheck.projects`. A v4 consumer already has
   this single authority. Do not keep a second list in the quality profile.
3. Replace FMS `featureProfilePath` with a neutral `topologyPath` and set
   `schemaVersion: 5`. Add one invocation `budgetMs`, for example 120000 after
   measuring the consumer's full check.
4. Keep an exact root development dependency on the qualified Stack Toolchain.
   The existing installed tool/version checks and ordinary build/typecheck gate
   still apply. Regenerate the consumer's canonical manager lock normally.
5. Run static, scope and full quality commands plus the consumer's complete
   required checks. A scope-only pass proves selection/context, not lint success.

```yaml
schemaVersion: 5
budgetMs: 120000
sourcePolicyPath: architecture/source.yaml
suppressionPolicyPath: architecture/suppressions.yaml
topologyPath: architecture/quality-topology.json
lintConfigPath: lint.typed.json
toolchainConfigPath: toolchain.config.json
scripts:
  fast: check:fast
  full: check
  scope: quality:scope
  typed: lint:typed
```

Optional `bridgeAdmissionsPath`, `nativeChecks` and `assets` retain their
existing semantics. The script IDs above must exist in `package.json`, with
required fast/full reachability and the correct scope/full command distinction.

Check the lint `extends` entries during migration. V5 accepts exact contained
relative `.json` paths and bare package JSON subpaths with no `exports` map or
an exact string-valued subpath export. Conditional/wildcard exports, package
`#` imports and self references reject explicitly. For those forms, select the
actual contained JSON file, for example
`./node_modules/stack-toolchain/presets/oxlint/type-aware.json`. Package-root
symlinks used by pnpm remain supported inside the consumer. This bounded lint
reference contract avoids stale Node resolution caches; it does not restrict
ordinary package-based TypeScript `extends`.

## Consumers without FMS

Hand-author technical topology using the public
`quality-source-topology/v1` schema. No standard identity or package adoption is
required. A single root package can use:

```json
{
  "schemaVersion": 1,
  "censusRoots": ["."],
  "packageRoots": ["."],
  "sourceRoots": ["src"],
  "testRoots": ["tests"],
  "excludedRoots": ["dist"],
  "toolingFiles": []
}
```

For a monorepo, list broad package containers in `censusRoots`, exact package
roots in `packageRoots`, and exact production/test scopes separately. Include
`.` if the root manifest participates. Do not use a narrow census to hide new
packages or a file-name convention to exempt production tests. The independent
workspace inventory and physical source census remain required evidence.

Architecture-specific roles, domain names and allowed edges stay in the
consumer's existing source policy. Core neither supplies nor mandates DDD, FMS,
layers or a business package layout.

## Consumers already using FMS

Use the opt-in FMS package's pure projection:

```ts
import { projectQualitySourceTopology } from "@agent-teams/feature-module-standard/quality-topology";

const topology = projectQualitySourceTopology(fmsProfile, quality.sourcePolicyPath);
```

The mapper preserves flat/nested FMS v1/v1.1 interpretation, the flat source-policy
link, nested layout matching, test roots, exact generator paths and the fact that
pending structural adoption does not remove production sources. It returns
neutral data without reading files or starting processes.

If committing a generated projection, add `derivedFrom` bindings to every
consumer file that determines it. Each entry is `{ "path": "...", "sha256":
"<64 lowercase hexadecimal characters>" }`. Bind the FMS bytes and the quality
profile that supplies the expected source-policy path. Run generation/checking
on an existing required repository route. A stale binding rejects through the
standalone quality command as well.

This repository uses `node tools/quality-topology.ts --write` to regenerate and
`node tools/quality-topology.ts --check` to verify. Other consumers own their
generation command and paths; core never runs a consumer generator. Keep the
separate FMS architecture gate. Freshness is not proof of the generator's semantic
correctness or a replacement for that gate.

## Coherence, limits and retry behavior

The check observes consumer file membership and bytes, including local compiler
configuration and generated output. It verifies before real tools execute and
before success. Persistent input changes cause an input/execution failure; finish
the edit/build and run the command again. Even a concurrent documentation edit
can conservatively invalidate the run. Identical-byte regular replacement is
allowed; symlink and containment restrictions remain.

The installed dependency tree must stay stable. Package-based compiler configs,
type declarations and executable bytes are not fully attested by this check.
Existing exact tool identity admission remains required. Do not interpret a
successful result as an atomic or hermetic filesystem snapshot.

The full [resource and deadline contract](../reference/quality-source-coverage.md#consumer-input-coherence-and-resource-bounds)
sets finite file/count/read limits. The invocation budget includes observation,
verification and tool stages. Measure the consumer's work before choosing it;
do not divide it into independently reset child budgets.

## Qualification and rollback

Before accepting migration, demonstrate both a real failing source and its
corrected passing counterpart with the selected installed tools. Preserve
unclassified-source/package rejection, protected rule and route checks,
native/assets, bridge identity and complete ordinary consumer gates. Missing
tools, malformed input and cancellation are not successful lint-defect evidence.

Keep the previous pinned major and its previous profile together for a coherent
rollback before a consumer accepts the upgrade. Do not mix a v5 profile with an
old package or restore executable compatibility branches in the new core.
No journal or transaction recovery migration is part of quality v5.
