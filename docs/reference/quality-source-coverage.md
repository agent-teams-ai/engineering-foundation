# Production quality coverage

Status: Implemented candidate with local CLI wiring and packed qualification evidence.
Final repository verification, release acceptance and consumer activation remain separate requirements.

The `quality-coverage` technical feature owns the
`quality.source-coverage` capability. It compares an independently observed
production universe with consumer-owned semantic classifications, suppression
coverage, protected lint settings and required command routes. It does not own
the consumer's package catalog, business architecture or waiver approvals.

The application separates three operations. Static validation accepts file,
configuration and route observations without a process executor. Explicit scope
execution additionally compares the pinned tool's actual selection with the
production universe and checks compiler project inclusion. Full execution uses
the same prepared tool session and runs typed lint once after those prerequisites
pass. A scope result does not establish absence of lint violations.

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

The current language contract supports `.ts` (including owned `.d.ts`) and
`.mjs` lint sources, plus classification and gate wiring for `.c` and `.h`.
It does not qualify `.tsx`, `.mts`, `.cts` or other source extensions. Preserve
existing consumer checks for these files until their coverage is explicitly
qualified; do not remove fixtures or classify production as tooling to make
adoption pass.

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
membership applies to TypeScript files, including owned `.d.ts` declarations.
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
coverage. Layout/source-root disagreement is an input error.


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
