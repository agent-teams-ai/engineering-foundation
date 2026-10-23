# Production quality coverage

Status: Implemented candidate with local CLI wiring and packed qualification evidence.
Final repository verification, release acceptance and consumer activation remain separate requirements.

The `quality-coverage` technical feature owns the
`quality.source-coverage` capability. It compares an independently observed
production universe with consumer-owned semantic classifications, suppression
coverage, protected lint settings and required command routes. It does not own
the consumer's package catalog, business architecture or waiver approvals.

Discovery retains the broad repository census and reopens package-level `dist`
and `coverage` when existing production source roots or runtime boundary roots
explicitly declare source there. Runtime roots may name directories or exact
files, including outside module source roots. Declared roots must exist and
remain contained and symlink-free. Ordinary ungoverned generated output and
dependency directories retain their discovery exclusions; a compiler output
directory alone does not declare production source. The same census supplies
static checks, scope execution and full execution.

The application separates three operations. Static validation accepts file,
configuration and route observations without a process executor. Explicit scope
execution additionally compares the pinned tool's actual selection with the
production universe and checks compiler project inclusion. Full execution uses
the same prepared tool session and runs typed lint once after those prerequisites
pass. A scope result does not establish absence of lint violations.

Full `quality check` parses every TypeScript source in the classified production
inventory with the private OXC adapter. It rejects an `as` or angle assertion
through explicit `unknown` followed by another assertion, including parentheses,
comments, non-null and `satisfies` wrappers. The target type name has no effect.
Source read and parse failures reject the check. Scope mode remains a coverage
observation and does not run this syntax check.

The v1 quality profile remains the default without admissions: explicit `unknown`
bridges reject during full checks. Opt into admissions with `schemaVersion: 2`
and the optional `bridgeAdmissionsPath`, which names one contained JSON or YAML
data file. That admission file has `schemaVersion: 1` and a finite `bridges` array.
Each record has exactly `path`, `start`, `end`, `sha256`, `rationale` and
`rejectingTest`. Start and end are OXC's zero-based source offsets for the full
outer assertion; SHA-256 covers that exact source slice. Paths are relative to
the consumer root. Rationale is concise and the test path must resolve to a
contained regular file. Duplicate, stale and unmatched records
reject. With no path, the admission set is empty. Foundation verifies identity
and test-file existence; the consumer must review semantic safety and actually
run the rejecting test in its gates. Reading a path is no evidence that a test
ran or rejects the relevant false claim.

This rule governs explicit syntax only. It cannot prove an assertion safe,
resolve semantic aliases of `unknown`, follow an intermediate variable, or
detect a dishonest predicate. Admissions never waive another lint, schema,
source-coverage or runtime check. Foundation owns syntax and evidence identity;
the consumer owns bridge rationale and behavior checks. Product execution and
lifecycle orchestration remain with its Host. The scanner is a fixed private
quality helper, not a new Assembly capability or a universal FMS adoption claim.

For example, a newly discovered
`packages/contexts/private-worker/src/main.ts` needs one classification in the
existing source authority and inclusion in suppression governance. Moving it to
`src/fixtures/main.test.ts` does not make it test code. An ignored production
file and a selected file without production or test classification both violate
exact coverage. Legitimate selected tests are allowed: production must equal
actual selection intersected with production, after unknown selections reject.
Full lint counts and diagnostic paths remain bound to the complete selection.
Markdown documentation remains visible in the file census but is not a lint
source. Native C files and headers require consumer-owned gate mappings;
unknown source languages receive an explicit unsupported-language diagnostic.

The current language contract supports `.ts`, `.tsx`, `.mts` and `.cts`,
including their declaration forms, and `.mjs` lint sources, plus classification
and gate wiring for `.c` and `.h`. Other source extensions remain unqualified.
Preserve existing consumer checks for those files until their coverage is
explicitly qualified; do not remove fixtures or classify production as tooling
to make adoption pass.

The protected configuration reader accepts a bounded JSON `extends` closure
and rejects `jsPlugins` in every visited configuration, including inherited
configurations. Consumers with executable architecture plugins can keep those
plugins, their settings and dependent rules in their existing fast lint config.
A separate typed config can extend shared data-only rules, with explicit root
suppression options. This split requires consumer checks proving that boundary
rejections, strict rules, file selection and type context are preserved. It does
not by itself activate the shared capability or qualify unsupported extensions.

Static protection observations carry the mandatory names derived from the
versioned presets separately from observed assignments. Accepted configuration
groups supply complete assignment identities and expected values, including
inherited rules and individual overrides. Missing, duplicate, unknown or altered
assignment observations reject; extra stronger consumer rules remain valid.
Required routes compare the accepted profile entry and mode to exactly one
reachability observation before tool execution.

Missing tools, malformed tool evidence and cancellation produce execution or
input errors through the existing Foundation report contract. They cannot count
as successful detection of an injected lint defect. Qualification must identify
the expected file and tool rule and demonstrate a passing corrected counterpart.

Foundation declares the capability in root configuration v2 using
`architecture/foundation/quality-source-coverage.yaml`. Its fast gate reaches
`quality:coverage:scope`; its full gate reaches `lint:typed` through `lint`.
Both use the local build's CLI. The full gate has one typed execution.
The repository's `quality:scope:check` retains only EF inventory, language,
ambient-rule coverage and exact exception checks, with no Oxlint selection or
execution. The shared capability owns suppression coverage and tool selection.
The standalone compiler and FMS/ambient gates remain required. Historical donor
tool invocations remain test-only parity references. Final packed qualification
is required before this extraction is accepted for release.
Installing a future package version alone will not activate this capability.

The existing FMS test mappings cover package-local tests. Exact generator files
from FMS provenance supply tooling classification outside production source;
generators inside source roots retain full production protection, and sibling
scripts gain no exemption.
Outside production roots, a source with exactly one explicit `development`
owner in the existing source policy is development tooling, not production.
Its normal consumer lint and source-boundary gates remain required. Missing,
unknown or ambiguous ownership cannot grant this classification. Files inside
production roots always retain production protection, even if their boundary
is marked development. Native C/header gate requirements are unchanged;
`development` metadata alone cannot hide native source. This uses existing
source-owner facts, not a second list of excluded scripts in the quality profile.

The profile's required `compilerProjects` lists existing consumer-owned production
project paths, for example `config/production.json`. These paths are independent
of module directories. The consumer's pinned compiler interprets project options
and references; coverage checks its reported files and never synthesizes a
`tsconfig.json` path from each module root. Missing projects, missing referenced
declarations and compiler failures are prerequisite errors. List the actual
production projects rather than an empty solution file that reports no sources.

An observed `.json` file explicitly listed in `compilerProjects` is configuration,
including when it is inside a production source root. It stays in the file census
but does not participate in lint selection or override selector classification.
This exemption never overrides independent source discovery. Other JSON files
and TypeScript, JavaScript or native sources remain subject to classification.
A selector matching only compiler configuration has no classified lint files and
is rejected. Static checks establish contained file existence; executable scope
checks use the pinned compiler to validate configuration, including JSONC.

Owned `.mjs` build adapters remain in lint selection and suppression coverage.
Their inclusion does not claim TypeScript compiler coverage: production project
membership applies to TypeScript files, including owned `.d.ts` and `.d.mts`
declarations.
The JavaScript adapter must still have one semantic owner and cannot disappear
from the observed Oxlint selection. Native execution qualification remains
consumer-owned.

Maintainability overrides may use larger finite numeric ceilings only when their
observed files are classified exclusively as tests by the consumer topology.
A production file named `*.test.ts` or placed under `src/fixtures` retains
production protection. Unmatched selectors and selected files without a known
classification are input errors. Correctness rules and error severity remain
protected for test overrides as well.

Topology normalization accepts the flat FMS `modules` form and the nested
`scope.productionModules` / `adoption.abstractLayout.modules` form. Nested
workspace containers define discovery, while explicit layout records supply
test roots. Structural adoption status does not remove modules from quality
coverage. Layout/source-root disagreement is an input error. Both forms accept
Feature Module Standard v1 and v1.1 (a v1.1 sub-feature or composition contract
does not change the module-level topology); every other version or standard is
rejected.


Native C source and headers stay in the production census, including files
outside a module's `src` directory. Optional `nativeChecks` entries map an
existing source `boundaryId` to a consumer package `script` ID. Every native
file requires exactly one mapping and its script must be reachable from the
full gate. The supported native terminal is `node scripts/<path>.mjs`; its file
must exist within the consumer. Missing ownership, missing files, ambiguous
mappings, mappings without current native source, removed routes and no-op
package commands are rejected.

For example, `nativeChecks: [{ boundaryId: custody.native, script: native:check }]`
uses the consumer's existing boundary roots. The full entrypoint must reach
`native:check`, whose package command invokes its existing native checker.
Replacing that command with `true` fails the native-route check.

This validates native classification and required wiring only. Native execution,
platform applicability, and the behavior of the consumer's checker remain
consumer-owned qualification. Oxlint selection must equal the lint-applicable
production files; native files cannot disappear from ownership or suppression
coverage merely because Oxlint does not select them.


Root-only suppression options must be explicit in the selected consumer lint
configuration: `options.respectEslintDisableDirectives: false` and
`options.reportUnusedDisableDirectives: "error"`. Oxlint does not inherit
these options through `extends`. Missing root values fail the protected-config
check; importing the Foundation preset alone is insufficient for this contract.
The installed corpus checks that an ESLint disable directive cannot hide a
floating Promise. Existing suppression governance still owns permitted waivers.

Required command chains containing literal `false`, including through a nested
literal pnpm script call, cannot establish the required route. Ordinary compiler
commands before the gate remain supported; this check is not a shell interpreter.

The shared parser distinguishes structural script inclusion from this stricter
quality-route check. FMS retains its existing structural guard: a failing
prerequisite is still a failed shell gate, not a successful bypass. Quality
coverage separately rejects literal failure anywhere in its required route.

Package script bodies have a separate nonempty 16 KiB UTF-8 limit; profile names
and paths retain their 1024-character bound and configuration reads retain their
existing size bound. This admits explicit monorepo command chains without making
command bodies unbounded.

Static route declarations support literal manager script calls and `node
<repository-relative JavaScript-or-TypeScript-file> run <script>` (or `script`).
A Host `tool agent-teams-foundation quality check --consumer .` declaration is a
full route; only the scope route includes `--scope-only`. Exact arguments and
safe paths are required. Known script edges must exist, and literal failures,
cycles, excessive depth, OR and multiline route chains reject. Opaque atomic
build siblings retain their existing declaration-only treatment. Selecting and
reading a native Host dispatcher proves file readability, not its implementation
or native execution. Runtime observations and qualification remain separate.

## Exact nonrunnable assets (v3)

The additive `quality-source-coverage/v3` profile retains v2 bridge admissions
and adds optional `assets`. Each entry has exactly `path`, `kind`, `boundaryId`
and `script`. Kinds are closed: `protobuf` requires an exact `.proto` path;
`sql-migration` requires an exact `.sql` path. No directories, globs or arbitrary
extensions are admitted. The path must be a current production-census file with
exactly the named semantic owner; it retains suppression governance. Duplicate,
stale, unknown-owner and extension-mismatched mappings reject. Existing v1/v2
profiles cannot declare assets and retain their unsupported-language behavior.

The named root package script must be reachable from the full entrypoint. Its
bounded declaration may contain contained Node checker files (including `.ts`),
`buf build`, `buf lint`, `buf format --diff --exit-code`, and a preceding
`tsc --project <path>.json --noEmit`, joined only with `&&`. Readable Node Host
dispatch declarations retain their existing static-only meaning. Literal failures,
no-ops, cycles, shell masking and missing checker files reject. Foundation does
not start validators or certify their implementation, pinning or result. Consumers
must qualify actual Buf and database migration gates, including malformed and
renamed executable inputs, and preserve those gates in full checking. Assets
never participate in TypeScript/Oxlint selection or compiler context. An adjacent
undeclared file remains governed and unsupported; an asset declaration cannot
transfer to a renamed executable or hide a new sibling.

For example, `assets: [{path: packages/example/src/contracts/example.proto,
kind: protobuf, boundaryId: example.contracts, script: wire:check}]` binds an
existing owned input to its existing validator. This is connectivity evidence,
not a source-language parser or an execution receipt.

## Retired temporary duplicate observation

Repository Mutation's read-only Node `inspectRetiredTemporaryDuplicates` seam
recognizes only its native `.foundation-retired-evidence-/UUID/owned-temporary`
geometry. A bounded contained census supplies candidate names. A terminal leaf
requires real symlink-free ancestors, a single leaf in its retirement directory,
exactly two hardlinks, stable bounded bytes and physical identity matching one
ordinary canonical sibling. That sibling remains in the ordinary census; native
retirement spelling alone grants no exemption. This establishes duplicate custody,
not authenticity of historical execution, deletion or recovery authority.

Quality coverage removes only those proved duplicate leaves from its product
source classification. It retains the broad filesystem census and every canonical
counterpart. Unknown tokens, extension changes, additional or nested files,
symlinks, replaced inodes, missing counterparts and ambiguous hardlinks cannot
hide product source. Evidence that no longer has a physical counterpart stays
unqualified and fails ordinary coverage; no persisted transaction format changes.
The source implementation and focused fixtures do not establish release, registry
adoption or a successful complete consumer gate.


## Toolchain-owned tools and project authority (v4)

The `quality-source-coverage/v4` profile replaces `compilerProjects` with
`toolchainConfigPath`, pointing to the consumer-owned data-only Stack Toolchain
configuration. Its `typecheck.projects` is the single project list used by both
quality observation and execution. Existing v1–v3 schema bytes remain unchanged.

Foundation resolves the exact root development dependency `stack-toolchain` and
reads its installed `toolchain-manifest.json`. Tool versions must agree with that
package's declared exact dependency graph; tools resolve from that package, never
from PATH, ancestor installations or an independent Foundation version table.
The consumer retains ownership of project paths, source boundaries and exceptions.

Quality lint source inventory uses `--listFilesOnly`, not semantic typechecking.
The sequential source-only checker does not replace the existing explicit build
gate for project-reference graphs. Native, source coverage and public API gates
continue to apply independently.
