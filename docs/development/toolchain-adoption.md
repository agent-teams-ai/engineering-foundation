# Repository toolchain adoption

The normal repository `typecheck` route bootstraps the workspace packages through
`build`, then invokes the installed registry Stack Toolchain once for the standalone project group in
`toolchain.config.json`. That configuration is the authoritative selected project
set; the coverage profile refers to it instead of maintaining a second list.
Stack Toolchain runs tsrs first, Bun only after a classified engine failure, and
TypeScript 7.0.2 only after both earlier engines fail. Source diagnostics stop the
chain.

`build` remains the official pinned TypeScript reference-graph build. It emits the
workspace artifacts needed to execute the CLI and preserves reference semantics;
the standalone checker never flattens that graph. The local-mode parser oracle,
native API SDK tests, native release tooling, and parser-spike checks retain their
explicit official TypeScript commands because those qualifications exercise the
pinned compiler/parser contract. Ordinary standalone tooling and runtime tests
use the selected checker group rather than repeated official compiler invocations.

The existing lint routes retain Foundation's complete governed coverage authority
and selected-file adapter; changing their scope is not part of this adoption.

## Registry adoption status

The supported public release A (`stack-toolchain@0.1.0`) was published through
[OIDC release 39948842338](https://github.com/agent-teams-ai/engineering-foundation/actions/runs/39948842338)
at source `d815b1176c263f4d2e66421822b84b15db591dfc`. The root declaration pins `0.1.0`
and `bunfig.toml` sets `[install] linkWorkspacePackages = false`. Bare exact
versions and same-name npm aliases both silently select a matching workspace
under Bun 1.4.3's default configuration. Fresh disposable tests proved the
explicit install setting selects the registry artifact and retains intentional
`workspace:*` links. All other repository internal dependency declarations were
inspected and already use explicit `workspace:` protocols.

The normal command resolves `node_modules/stack-toolchain/dist/cli.js`, not the
sibling source package. The dependency-declaration profile explicitly lists
`stack-toolchain` in `exactRegistryDevelopmentOnlyPackages`; the existing SDK
policy accepts the bare exact registry pin without an alias-policy extension.
The consumer toolchain adapter rejects an installed manifest whose real path
escapes consumer `node_modules`, preventing workspace source symlinks from
serving as registry qualification.

Both package-manager locks now record the published archive integrity:
`sha512-HU+yLceArzkSYmd42JyAfKONn29L779EWroBzkVYVXZY+/7dYhvvMuO25dW1fjs+WRc8tsOAJW+qSocC0RdZCw==`.
Canonical Bun installation and the separate Node/pnpm projection passed, selecting
contained `.bun/stack-toolchain@0.1.0` and `.pnpm/stack-toolchain@0.1.0` registry
packages rather than sibling source. The Bun producer-source dependency projection
restores only the shadowed source workspace dependency links; the complete installed
graph check still validates all required dependencies and peer assignments.
Complete final CI, packed consumer qualification and the separate formatting phase
remain required before final adoption and release. The official source build remains
an owner/bootstrap gate, not registry installation evidence.

Physical TEST evidence is retained under `.worker-tmp/`: fresh alias without the
setting (`TEST-bun-alias-fresh-53vd2etk`) resolves `../packages/local`; fresh bare
exact with the setting (`TEST-bun-registry-nolink-bare-hywbk9_g`) resolves
`.bun/jsonc-parser@3.3.1/node_modules/jsonc-parser`, records registry integrity in
`bun.lock`, and preserves the explicit `TEST-other` workspace link. These are
historical disposable mechanism probes; the actual registry installations above
provide the subsequent release A selection evidence.

## Consumer migration for the planned Foundation 3 release

Status: breaking migration preparation. This source phase does not establish a
qualified Foundation 3 / Stack Toolchain / companion registry tuple or consumer
adoption. Source manifests, packed TEST candidates and synthetic installs do not
establish registry availability. Select exact released versions only from the
qualified release record after publication; do not copy a TEST archive path or
invent pins. A package already published independently does not qualify the
complete companion tuple.

Foundation 3 removes `./presets/*` from both its package exports and shipped
files. An old `extends` reference therefore fails even if the consumer keeps its
existing quality profile. Technical presets move to the separate
`stack-toolchain` development dependency. Its dependency direction is
independent of Foundation; project paths, source scopes and architecture remain
consumer-owned.

Make one reviewed consumer migration with the following changes:

1. Add one **exact published** `stack-toolchain` version in the root
   `devDependencies`, alongside the exact Foundation 3 pin. Keep both development
   only. Ranges, workspace links, local source links and ancestor/global tools do
   not satisfy the installed-toolchain admission check. If dependency declaration
   policy is enabled, admit `stack-toolchain` in its
   `exactRegistryDevelopmentOnlyPackages` list. Update any consumer-owned
   dependency allowlists and copied qualification fixtures that encode the old
   pins or preset paths. A projection that already carries all root development
   dependencies needs no additional dependency mapping for this package.
2. Change the Node TypeScript preset and both Oxlint preset references together:

   | Consumer configuration         | Previous Foundation reference                                                       | Replacement export (planned)                                    |
   | ------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
   | TypeScript `extends`           | `@agent-teams/engineering-foundation/presets/typescript/node.json`                  | `stack-toolchain/presets/typescript/node.json`                  |
   | Oxlint syntax config `extends` | `./node_modules/@agent-teams/engineering-foundation/presets/oxlint/node.json`       | `./node_modules/stack-toolchain/presets/oxlint/node.json`       |
   | Oxlint typed config `extends`  | `./node_modules/@agent-teams/engineering-foundation/presets/oxlint/type-aware.json` | `./node_modules/stack-toolchain/presets/oxlint/type-aware.json` |

   For example, a consumer's existing typed Oxlint configuration starts with:

   ```json
   {
     "extends": ["./node_modules/stack-toolchain/presets/oxlint/type-aware.json"]
   }
   ```

   Retain its local options, exclusions and stronger rules. Migrate already
   selected maintainability presets to the corresponding replacement
   `stack-toolchain/presets/oxlint/maintainability.json` or
   `stack-toolchain/presets/oxlint/maintainability-tests.json` export. Adding a new
   budget remains an explicit consumer policy change.

3. Preserve existing strict TypeScript projects, reference-graph build gates and
   syntax/typed lint selections. Using the presets does not require adopting
   the shared CLI or replacing existing scripts. Update consumer-owned runtime-bin
   mappings only when changing scripts to invoke that CLI. If adopting it, configure those
   same selections explicitly; `lint.syntax` can retain the broad syntax lane
   while `lint.config` and `lint.paths` retain the existing typed lane. A package
   upgrade must not silently expand typed lint to every test or tooling file.
4. Update any installed Feature Module Standard Node runner to the qualified
   compatible 0.3.x release with the Foundation 3 peer window. The companion
   [FMS migration](feature-module-standard-foundation-3-migration.md) defines its
   qualification; do not bypass peers with overrides or a forced install. For
   managed Docs consumers, adopt the exact qualified Docs package Cohort and
   its governed assets through the existing managed migration route. An arbitrary
   mixture of individually available package versions is not a qualified Cohort.
5. Regenerate the consumer's applicable lockfiles with its declared package
   managers; retain both locks when two package-manager profiles are supported.
   Then perform fresh frozen registry installs. Update the manifest,
   preset references, scripts or profiles changed by this migration, compatible
   companion pins, managed Cohort evidence and locks in the same adoption PR.
   Keep immutable ADRs, release baselines and historical recovery bytes intact.

### Existing quality profiles remain selectable

The current Foundation 3 implementation requires the exact root
`stack-toolchain` development dependency for `quality.source-coverage` profiles
**v1, v2 and v3 as well as v4**. Consumer tool resolution and protected Oxlint
preset inspection are shared across these profile generations. Keeping a v1–v3
profile does not retain the removed Foundation preset exports or tool ownership.

This dependency migration does **not** require a profile schema upgrade. Existing
v1–v3 profiles retain their `compilerProjects`; adopt v4's `toolchainConfigPath`
and single `typecheck.projects` authority only as a separate explicit choice.
See the [quality coverage contract](../reference/quality-source-coverage.md#toolchain-owned-tools-and-project-authority-v4).

### Qualify the consumer before merging

Verify that the installed package identity matches the exact root pin and its
physical path stays inside the consumer's `node_modules`. Resolve each new preset
from that installation; no reference to Foundation's removed preset subpaths
should remain. Run the consumer's existing full Foundation check, lint, strict
typecheck, tests, FMS checks and managed Docs checks that apply, with required CI
on the exact adoption change. Retain rejecting probes for a missing or mismatched
Toolchain and a weakened protected lint rule. Follow the existing
[consumer integration gate](consumer-adoption.md#required-integration-gate);
a successful TEST candidate alone does not complete registry adoption.

If adoption fails, restore the previous exact package tuple, configuration,
managed evidence and locks together. Resolve in-flight recovery under its exact
qualified implementation before cutover; never rewrite historical evidence or
leave a mixed preset/package installation.

## Contracts-first source preparation

This branch prepares the Foundation 3 contracts and installed Stack commands.
The `format.paths` profile records the full planned maintained-source scope and
protected generated/frozen evidence exclusions. The root has no activated
`format:check` gate in this phase; no existing format gate has been removed.
A separate formatting/private-helper change must carry the broad mechanical
cleanup and activate the required full-scope `format:check` route before the
final Foundation 3 release and fleet adoption. A prepared profile or prior TEST
formatter result does not qualify these current source bytes.

The source base retains the official nine-package manifest versions and
changelogs. Stack 0.1.0 publication and its release cohort are verified in the
retained release receipts. Both canonical Bun installation and the isolated Node
projection now consume that exact registry package; both lockfiles have been
regenerated and the complete installed graph qualified. These installation
results do not replace final consumer CI or packed-artifact qualification.

Final Foundation 3 release and fleet adoption remain pending both the qualified
contracts phase and the required full-scope formatting and helper phase. Bind the
final Foundation 3 package tuple and compatible companions to their own public
integrity and provenance receipts after that release.

## Shadowed producer source dependencies under Bun

When the root consumes the published same-name Stack package, Bun omits its
source workspace importer. The canonical Bun install edge projects only the
source package's missing dependency links from the contained installed registry
graph. Source/catalog declarations remain exact authority; mismatched, missing
required or escaping packages fail before links are created. Root consumer Stack
resolution and registry archive bytes are unchanged. The complete installed graph
qualification still checks the producer source and all other workspace contexts.
This source-only projection is install output under the producer's `node_modules`,
not a published package, source fallback or extra package download.
