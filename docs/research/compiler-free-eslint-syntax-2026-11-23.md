# Compiler-free ESLint syntax rules

Date: 2026-11-23. Status: implementation plan after a successful bounded
prototype. Foundation base: `e38d8444f74cceef37c366f4e28ed1918b214d4a`.
The proposed export is not implemented or published. The current source package
version `stack-toolchain@0.2.0` is not evidence of a registry release.

## Problem and owner

ReviewRouter's existing ESLint gate uses twenty recommended TypeScript syntax
rules. Their decisions do not use a TypeScript checker, but the upstream plugin
and utility barrels initialize a classic TypeScript implementation. The inspected
`@typescript-eslint/eslint-plugin` and `@typescript-eslint/utils` 8.73.0 package
contracts still require TypeScript `>=4.8.4 <6.1.0`. Pure utility subpaths do not
make that package graph supported with TypeScript 7. Executing an old compiler,
overriding its peer range, disabling checks or replacing lint findings with a
successful parser probe would not resolve the gate.

[ADR-0064](../decisions/0064-independent-stack-toolchain-package-boundary.md)
assigns shared executable pins and technical presets to Stack Toolchain. The
[extraction admission invariant](../architecture/executable-capabilities.md#extraction-admission-invariant)
requires a reusable mechanism, disposable consumers and a real consumer in the
same delivery. This work follows that owner from the start. ReviewRouter keeps
its source scope, globals, ignores, suppressions and rule policy.

The concrete guarantee is an ordinary ESLint 10 syntax gate with its existing
diagnostics, fixes, suggestions, directive behavior and complete file scope,
without initializing a TypeScript compiler. The guarantee is bounded to the
qualified parser, rules, host and platform profile. It does not establish general
parser equivalence or type-aware linting.

## Chosen shape and alternatives

Add the public typed ESM subpath `stack-toolchain/eslint-syntax`. It exports a
normal ESLint plugin, its qualified parser and a technical recommended flat
configuration. Consumers continue to use ESLint's CLI and can register the plugin
under their existing `@typescript-eslint` namespace. Plugin metadata identifies
Stack Toolchain; it does not impersonate the upstream npm package.

The root entry and existing Oxlint CLI route remain independent of this export.
No new CLI, file discovery, selector interpreter, suppression engine, tokenizer,
capability framework or top-level package is required. Source belongs to a
technical ESLint feature under `packages/stack-toolchain/src/features/`, reached
through a thin `src/eslint-syntax.ts` public entry. A technical adapter needs no
invented domain model.

| Route | Evidence and decision |
| --- | --- |
| Supported upstream syntax-only export | Preferred if published with a genuinely compiler-free package and type contract. The inspected 8.73.0 plugin/utils exports do not supply it. |
| Existing Oxlint route | Remains supported for its existing contract. Replacing the current ESLint CLI, rule IDs, directives and rule semantics would be a separate consumer migration. |
| Bounded owned extraction | Selected for qualification: retain the twenty rules and minimal helper closure, use public pure AST/scope packages and the public generic ESLint contract. |
| Copying utils or changing peer ranges | Rejected: retains an unsupported compiler package graph or creates a much larger second type/runtime abstraction. |

The native parser is the published `eslint-parser-oxc@0.1.1`, with its own
`oxc-parser@0.148.0` dependency. This is a public parser integration, not a local
adapter that rewrites AST or substitutes modules. The qualified dependency set
uses one exact physical `@typescript-eslint/scope-manager`, `types` and
`visitor-keys` 8.73.0 closure. Equal version strings are insufficient because the
unused-variable collector uses `instanceof ImplicitLibVariable`.

The proposed host boundary is an optional exact ESLint 10.3.0 peer plus an exact
development host. Its packed declaration and npm/pnpm behavior must be proved
before finalizing that choice; no unsupported host range is implied. The parser
has its own mandatory ESLint peer, so optional Stack metadata alone does not
promise a host-free installation. Verify both an ordinary explicit-host consumer
and a no-host root-entry installation before describing optionality. Public
`@eslint/core@1.2.1` types describe rules without depending on the utils package.
Dependency declarations, both normal lockfiles and installed resolution must
agree. Parser/scope runtime dependencies use the owning exact catalog pins.

## Source reuse and licensing

The retained rule contract is typescript-eslint 8.59.1 at immutable commit
`52457932e5507b5ca01e720a541f3f8d01e09b9d`, not a claim to implement every later
upstream change. The source inventory records all twenty rule Git blobs, helper
imports and line counts. Keep a per-file modification ledger and original MIT
notices in the published tarball. Stack Toolchain's Apache-2.0 license does not
replace those notices.

The twenty rule files total 3,560 physical TypeScript lines. The unused-variable
collector adds 831 lines and the selected helper closure adds 222, for 4,613
retained lines before the ESLint core rule, typed contracts, assembly and tests.
The collector and `no-unused-vars` are the main semantic risk, not a trivial
import substitution.

| Retained rule | Independent rejecting and accepted boundary |
| --- | --- |
| `ban-ts-comment` | Bare ignore versus permitted described expect-error; comment location and Unicode description length. |
| `no-array-constructor` | Multiple arguments versus the permitted one-argument case; exact fix. |
| `no-duplicate-enum-values` | Duplicate versus distinct literal members; report the duplicate member. |
| `no-empty-object-type` | Empty interface/object versus a member; existing option defaults and suggestions. |
| `no-explicit-any` | Explicit any versus unknown; rest-option behavior and exact suggestion output. |
| `no-extra-non-null-assertion` | Duplicate versus single assertion; exact removal range. |
| `no-misused-new` | Interface constructor returning itself versus a distinct instance type. |
| `no-namespace` | Ordinary namespace versus permitted external module; declaration-file and ambient options. |
| `no-non-null-asserted-optional-chain` | Assertion after optional access versus ordinary optional access; suggestion range. |
| `no-require-imports` | Global require versus import or locally shadowed require; allow-list options. |
| `no-this-alias` | Direct alias versus permitted destructuring; allowed-name option. |
| `no-unnecessary-type-constraint` | Unknown/any constraint versus a meaningful bound; TSX/MTS/CTS generic-arrow comma. |
| `no-unsafe-declaration-merging` | Class/interface same-name merge versus distinct names; both declaration locations. |
| `no-unsafe-function-type` | Global Function versus explicit function or locally shadowed Function. |
| `no-unused-expressions` | Standalone identifier versus calls; TS wrappers, directives, optional calls, imports and JSX options. |
| `no-unused-vars` | Unused versus used/exported declarations; declarations, scope, type references and options listed below. |
| `no-wrapper-object-types` | Global wrapper type versus primitive or local shadow. |
| `prefer-as-const` | Repeated literal assertion/annotation versus as const; exact fixes and suggestions. |
| `prefer-namespace-keyword` | Identifier module versus namespace/external string module; keyword range. |
| `triple-slash-reference` | Forbidden path versus permitted lib/import directive; comments and default options. |

Copy only `collectUnusedVariables`, `getStringLength`, `getStaticStringValue`,
`isNullLiteral`, `escapeRegExp`, `isReferenceToGlobalFunction`, `isTypeImport`,
`referenceContainsTypePredicate`, `referenceContainsTypeQuery`, the small
`MakeRequired` type, and the required slices for definition-file detection and
global-directive name locations. Do not copy whole utils, misc or astUtils
barrels. Preserve the case-insensitive extended declaration suffix expression
`/\.d\.(ts|cts|mts|.*\.ts)$/`. Replace the one compiler import, used only for
`.cts`/`.mts`/`.tsx` extension constants, with those exact literals.

Evaluate ESLint's public `meta.defaultOptions` after option-merge qualification;
it is not assumed equivalent to the old factory. Upstream `applyDefault` clones
defaults and its deep merge preserves explicit nested undefined, while ESLint's
merge can restore a default. Array and mutation behavior also need independent
checks. Decide the smallest behavior-preserving implementation from those results,
without silently accepting drift or copying a broad utility framework. Small typed token,
function/loop and string scope-lookup helpers require explicit upstream provenance
and independent tests. No private runtime import is admitted.

The upstream `no-unused-expressions` wrapper reads a private ESLint core-rule
export. ESLint 10.3.0's public rules export is types-only. Following ESLint's
[custom-rule guidance](https://eslint.org/docs/latest/extend/custom-rules), retain
the necessary core behavior as an owned typed MIT extraction with exact source
and helper provenance. Keep the namespaced rule ID and qualify wrapper behavior;
do not assume the latest core and old wrapper are semantically interchangeable.

Expected incremental work is approximately 5,000–5,500 production/integration
lines and 1,000–2,000 test/fixture lines, with inventory, native packaging and
release work in addition. These are bounds for planning, not a line-count target.
Retained source is not newly invented language logic. Confidence in the selected
public boundary is 8/10, achievable reliability within the stated qualified
syntax contract 8/10 and maintenance complexity 6/10; these are engineering
judgments, not measured reliability or complete qualification.

## Completed admission evidence

Two separate temporary experiments ran on Node 26.11.1/Linux x64 before any
Foundation rule port. Neither changes a consumer configuration or certifies a
Foundation artifact.

| Evidence | Observed result | SHA-256 of retained result JSON |
| --- | --- | --- |
| Public parser/host boundary | 17/17 checks, including TSX, declaration modules, globals, directives, coordinates, ESM/CJS exports and pre-initialization guard controls. | `360d47ce91e1e712effe3068f66c4a5cd6a5c72c5f28a7b44510a42bcb579886` |
| One real rule and public generic types | Strict native TypeScript 7.0.2 with noUncheckedIndexedAccess, exactOptionalPropertyTypes and declaration checking; 13/13 runtime and rejecting checks. | `edd523f3366d9af20e0b041a81fa44ef1458651225aaca73f6523ebe3a8ef929` |
| Upstream source inventory | Twenty rule blobs and selected helper inventory; read-only evidence. | `b59d7ffe02429ec7f0f80cfb4216e57c51009bf7d1caf3805813911faad69ef8` |

The rule experiment retained actual `prefer-as-const` source blob
`eb0a1e12008e7dd4011426566e0915cbdd88f5c8`. It exercised real reports, fixes,
suggestions, tokens, scope, custom selector, public plugin/parser assignments and
shared physical ScopeManager/ImplicitLibVariable identity. Six rejecting compiler
fixtures independently checked an invalid message ID, missing report location,
invalid fix output, missing token/scope properties and a wrong listener node.
The deny-only Node load guard rejected both ESM and CJS controlled initializers
before they could write their markers, with no compiler substitution.

The first negative-type harness expected compiler exit 2; native 7.0.2 returned
exit 1 with all six intended diagnostics. Original failed logs were retained,
and the corrected harness still requires the exact diagnostic code, fixture path
and distinguishing text. The parser experiment first expected a quoted JSX
attribute token to be String; the upstream token contract specifies JSXText.
Its independent oracle was corrected with the original receipt retained.

These results do not qualify the other nineteen rules or the complete collector.
The public generic fixer accepts unknown syntax-element arguments by design;
the prototype proves typed node use and edit result types, not rejection of
every invalid fixer input. Custom selector relationships are explicit typed
contracts with runtime fixtures, not inferred by a new selector engine.

## Implementation and required qualification

1. Commit this plan and its navigation before the full port; record independent
   review of the design and source/license closure. Preserve the active
   Foundation #468 Oxlint preset and ReviewRouter #977/#980/#982 ownership.
2. Add the narrow public entry, exact dependencies and compiled declaration
   contract. Port rules in bounded commits, preserving semantics and recording
   each intentional difference. Extend SourceCode types only for real callers;
   reject blanket casts, any-based adapters and type-check suppressions.
3. Add independent accepted and rejecting fixtures for every rule, with exact
   message ID/count/span and fix/suggestion output. Verify omitted, partially
   supplied and explicit option values against retained defaults, including
   nested undefined, array replacement and repeated-run non-mutation. Malformed
   syntax remains a fatal parse diagnostic.
4. Exercise the collector with imports used only as types, type queries and
   predicates, namespaces, overloads, parameters, caught errors, destructuring,
   ignored names, ambient/exported declarations, global comments and library
   globals. The unused declaration `const unused: 1234; export {};` must report
   in `.d.ts`, `.d.mts` and `.d.cts` modules. Verify nested scope and shadowing.
5. Preserve the three upstream recommended configuration layers: parser and
   namespace, core-rule overrides for TS/TSX/MTS/CTS, and recommended rules.
   Check all seven existing JS/TS extensions and explicit module policy. The
   real consumer's TS/TSX explicit-any override stays distinct from MTS/CTS.
   Compare full discovery, directives, unused-disable reporting and JSON
   diagnostics; no new exclusions, ceilings or suppressions.
6. Run source/tests through the existing strict required projects and complete
   inventories. Update feature/dependency/public-API/topology authorities for
   the real new entry, not broad exceptions. Do not hand-edit release-owned API
   baselines. Run the documented scoped cleanup after building owned sources.
7. Qualify emitted and packed artifacts in disposable npm and pnpm consumers
   with the actual exact ESLint host. Confirm export targets, strict public
   declarations, same physical scope module, native binding availability,
   shipped licenses and compiler-free loading. Verify no-host root-entry and
   ordinary explicit-host dependency graphs without peer suppression. Keep the negative initializer
   controls and native-platform matrix; no source symlink proves tarball use.
8. Complete changed/fast/workflow-security gates, independent technical review
   and the requested full native CI matrix on the final head/base. Preserve
   first failures and exact source/run/attempt evidence.
9. Add the regular package Changeset and let the normal release-owned process
   publish. Verify exact registry version, integrity, provenance and supported
   source before changing the real consumer's dependency and lockfile.
10. Adopt the released export in ReviewRouter while preserving its ESLint CLI,
    namespace and policy. Run its complete lint corpus, full CI/E2E and required
    publication gates. A successful Foundation release alone does not complete
    that consumer goal.

## Current delivery ledger

| Step | State |
| --- | --- |
| Current Foundation rules, catalog, ownership and original source inspected | Complete at the base above. |
| Parser admission and one-rule strict prototype | Complete in the bounded Linux scope above. |
| Plan and public owner navigation | This initial checkpoint. |
| Foundation rules, dependencies, artifacts and consumer integration | Not yet changed. |
| Foundation changed/fast/workflow-security preflight | Pending normal exact runtime/dependency preparation; not replaced by the prototype. |
| Independent final-source review and complete native CI | Pending implementation. |
| Registry publication and ReviewRouter adoption | Pending qualification and release. |

An independent technical plan review found no architectural blocker in the
initial design bytes (SHA-256
`2d474f70f1ec557e6c978aa842a20d50ec221430dcb90cb5a46765fcab644f64`).
Its two concrete findings are incorporated above: default merging requires
explicit equivalence evidence, and the parser's mandatory ESLint peer constrains
any optional-host claim. This is a plan review, not final-source approval.

The initial checkout has no installed Foundation dependencies or Bun executable.
The documented changed check requires the source-owned Bun 1.4.3 installation
and build, including when launched from Node. Its ordinary preparation remains
required before those gates can be claimed; the isolated Node diagnostic profile
is a separate documented route, not a renamed changed-check result.

## Reconstructed source checkpoint

The implementation was reconstructed in an isolated checkout after the temporary
working tree was lost. The first native strict compilation exposed a declaration
boundary the one-rule prototype had not established: the published
`@typescript-eslint/types@8.73.0` declarations import the classic `SyntaxKind`
and `Program` APIs from the TypeScript root. Native TypeScript 7.0.2 does not
export those APIs. No old compiler, unchecked declaration bypass, ambient
compiler shim or dependency override is admitted.

The implementation retains the actual parser's ESTree type contract privately,
including the host's parent-node relationships. Its internal operator maps keep
the identical literal value unions without referencing compiler enum keys.
Compiler/parser-options declarations are outside this syntax-only contract.
Raw Oxc types were inspected but cannot represent the parser's normalized AST
without changing the retained rule contract.

The public parser and scope modules are loaded through their normal package
entrypoints. Narrow runtime boundary checks require the exact published versions,
expected methods and constructors, and one physical scope-manager instance shared
with the parser. The original Visitor, PatternVisitor and ImplicitLibVariable
constructors are retained. Public package declarations expose ordinary ESLint
types; legacy compiler declarations do not enter the source or consumer graph.

The complete Stack Toolchain source project currently passes native TypeScript
7.0.2 with its unchanged strict, exact-optional, indexed-access and declaration
checks. Runtime semantic fixtures, complete inventories, both real lockfiles,
packed consumers, required full CI and independent final-source review remain
pending at this checkpoint. This is durable source recovery, not release or
consumer qualification.
