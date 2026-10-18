# Feature Module Standard

Opt-in checks for the organization
[Feature Module Standard](https://github.com/agent-teams-ai/.github/blob/main/docs/architecture/feature-module-standard/v1.1.md)
(`agent-teams.feature-module-standard`). The package is named after the standard
on purpose: the standard defines one architecture's layout and vocabulary, so
its checks never enter the architecture-neutral Foundation core. A repository
that does not adopt the standard never loads this package, and no core package
depends on it; the only dependency direction is from this package to the neutral
core (see [Architecture neutrality](../../docs/architecture/executable-capabilities.md#architecture-neutrality)).

Development and CI use only. Do not import it from product runtime code.

## What it checks

The kernel validates the declared structure of one production module. It has no
runtime dependencies, reads no files, runs no parser and widens no policy: every
fact (feature roots, role directories, curated surfaces, republications, declared
use edges) is input, and the consumer repository keeps its profile and decisions.

```ts
import { checkFeatureModule } from '@agent-teams/feature-module-standard';

const report = checkFeatureModule({
  // The profile's declared structure: every feature root and the directories or files mapped to roles.
  featureRoots: ['src/features/orders', 'src/features/billing'],
  roleRoots: [{ root: 'src/features/orders/domain', role: 'domain' }, { root: 'src/features/orders/api.ts', role: 'application' }],
  files, // production files, repository-relative, `/` separators
  surfaces: { public: [...], compositionContract: [...], compositionSurface: [...] },
  imports, // resolved edges: { from, to, mode: 'runtime' | 'type-only', line, reexport? }
});
// report.ok, report.diagnostics, report.features, report.metrics
```

The rules implement Feature Module Standard v1 and the v1.1 additions for
sub-features and composition contracts. `STANDARD` exports `{ id, version: 'v1.1', digest }` of the
implemented text (blob `bd949a9a670862fea851a7791fce772fdef3b4fc`,
[pinned organization blob](https://api.github.com/repos/agent-teams-ai/.github/git/blobs/bd949a9a670862fea851a7791fce772fdef3b4fc)),
so a profile can compare it with the digest it pins. Applicability follows declaration: a
sub-feature exists only where `featureRoots` declares it, so in any other module
a `features` directory inside a feature keeps its v1 meaning.

| Rules | Diagnostic codes |
| --- | --- |
| Tree: feature roots at `<features root>/<name>` and `<parent>/features/<name>`, one container name, only role directories, the container and mapped files below a feature root | `feature-root-placement`, `feature-duplicate`, `feature-undeclared`, `container-file`, `container-empty`, `entry-unmapped` |
| Test ownership: a test belongs to the deepest feature, sub-feature tests live in the mirrored test root, and a test uses another visible feature only through public, internal API and testing surfaces | `test-unowned`, `test-misplaced` (warnings: the standard says SHOULD), `not-visible`, `deep-import` |
| Visibility and curated surfaces: a sub-feature is visible to its parent and the parent's descendants; no deep imports | `not-visible`, `deep-import`, `surface-unowned` |
| Layer direction (v1): domain and application never import contracts; adapters reach siblings through the application core | `layer-direction` |
| Composition contracts (module-level composition is named by `moduleComposition`): they are composition code, only composition code depends on them, visible features only | `composition-contract-misplaced`, `composition-contract-layer`, `not-visible` |
| Assembly: only a parent's composition wires its direct sub-feature, and it wires every one that exposes a composition surface | `assembly-misplaced`, `assembly-missing` |
| Republication: declared, from a direct sub-feature, one level at a time | `republication-undeclared`, `republication-skips-level`, `republication-invalid`, `republication-mismatch`, `republication-not-sub-feature` |
| Declared use edges, when the consumer has a profile | `use-undeclared`, `use-edge-invalid` |
| Cycles: downward and lateral use edges, runtime and type-only alike; load-time cycles between files of different features | `feature-cycle`, `load-cycle` |
| Growth: depth warning and per-feature metrics (files, tests, sub-features, consumer file groups) | `depth-warning` |

Every code is in `ERROR_CODES` or `WARNING_CODES`; a MUST of the standard is an error and a SHOULD a warning
that does not fail the module. Diagnostics are sorted and stable. `invalid-path` reports any input path that is
not a repository-relative path with `/` separators.

For a tree that follows the default layout (`<features root>/<feature>/<role directory>`), `inferDirectoryLayout`
builds `featureRoots`, `featuresRoots` and `roleRoots` from the file list and a role-directory map.

Smaller pieces for repository-owned checkers: `layerDirectionAllowed`,
`findCycles`, `findOverlappingRoots`, `analyzeFeatureTree`.

## Fixtures

`@agent-teams/feature-module-standard/fixtures` exports `exampleSources`, the example tree as real source
files (`import`, `export * from`, `import type {}` statements) that a runner materializes and reads back, and
`conformanceCases`: the
informative examples of the standard, the nested-feature cycle cases and the
composition-contract cases as complete module descriptions with their expected
diagnostic codes. The kernel tests, and every adopting checker as its
conformance test, run the same data.

## Runner

`@agent-teams/feature-module-standard/node` checks a module on disk. It reads the declared roots through
`@agent-teams/engineering-foundation/source-graph`, runs the kernel and compares the per-feature metrics with
growth budgets from `@agent-teams/engineering-foundation/ratchet` (warnings only). Engineering Foundation `^1.8.0` is an
optional peer dependency: users of `.` and `./fixtures` do not need it.

```ts
import { checkFeatureModuleOnDisk, formatNodeReport } from '@agent-teams/feature-module-standard/node';

const report = await checkFeatureModuleOnDisk({
  consumerRoot: process.cwd(),
  sourceRoots: ['src'],
  testRoots: ['tests'],
  structure: { featuresRoot: 'src/features', roleDirectories: { domain: 'domain', application: 'application' } },
  surfaces: { public: ['src/features/orders/contracts/public.ts'] },
  budgets: [{ metric: 'sourceFiles', max: 40 }],
});
process.stdout.write(formatNodeReport(report));
```

The configuration is data. `structure` is either the default layout (`featuresRoot`, `roleDirectories`, declared
`subFeatureRoots`) or the profile's own mapping (`featureRoots`, `roleRoots`). Metrics available to budgets are `depth`,
`subFeatures`, `sourceFiles`, `testFiles` and every name of `fileGroups` (regular expression sources). A file the parser
cannot read fails the run, because its imports would be missing from the check. A bare specifier is not an edge: the
file graph reports packages and aliases as external, so a tsconfig alias that points into a feature is not seen.
`moduleComposition` names the module-level files permitted to use composition contracts or wire feature surfaces;
omitting it or supplying an empty list declares no module-level composition. Runtime and type-only export-from
references retain their republication provenance when passed to the kernel.

## Stability

Version 0.x. A break of the API or of a diagnostic code ships as a minor release
with a changelog entry and a migration note.
