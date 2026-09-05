# Repository Feature Module Standard

Status: Adopted; conformance guard implemented, existing layout migrations pending

[ADR-0046](../decisions/0046-feature-module-standard-adoption.md) adopts the
immutable organization [standard v1](../../standards/feature-module-standard-v1.md).
The [local profile](../../architecture/foundation/feature-modules.json) binds its
exact bytes and owns repository mappings. The vendored file reproduces the supplied
organization standard byte for byte; it is not a second repository-owned standard. It is data, not a plugin contract.
This repository does not currently claim whole-layout conformance.

## Concrete ownership

Production modules are the public packages in the existing
[publishable inventory](../../scripts/publishable-packages.mjs). `packages` is
the production root. Each module's `src` is its source root; exact public
exports and composition paths are assembly. There are no separate application
roots: distributable CLIs are exact module assembly paths, with behavior required
in a feature. `scripts`, `tests` and `spikes` are repository tooling/test roots,
not production exceptions. Qualification code shipped in `src` stays in scope.

| Module | Role | Existing feature mappings |
| --- | --- | --- |
| Repository Mutation | platform | known-file transactions (including qualification seams); mutation coordination |
| Document Authoring | platform | document authoring (including qualification); documentation observation |
| Docs Protocol | SDK | portable documentation; portable bootstrap; portable qualification |
| Docs Protocol Agent Teams | integration | consumer integration; managed qualification |
| Docs Protocol MCP | integration | documentation tools, transport contracts and adapters |
| Engineering Foundation | platform | each individual `capabilities/<id>`; command host; configuration input; Foundation check; validation reporting; local package mode; process execution; scaffolding; source inventory; transaction coordination; workspace inventory |

The profile lists exact paths, layers, public targets and existing focused test
mappings. New features use `src/features/<feature>` and
`tests/features/<feature>`. A technical feature needs a real owned operation,
not a ceremonial domain aggregate. Feature tests and module export/package tests
retain their existing owners; no mass move is implied.

Capability `contract` directories now contain transport-independent policy models
and capability identities after their loaders moved to inbound adapters. These
map to the owning application layer. Public transport contracts remain outer
contracts; a directory name alone does not determine its layer. Scaffolding
definitions and persisted-operation models belong to its application capability.
Module qualification export files are curated assembly; the fault mechanisms and
crash scenarios remain owned by the feature they qualify.

## Enforcement and creation

```bash
pnpm quality:scope:check
pnpm architecture:features:check
pnpm architecture:features:plan -- engineering-foundation example inspect --from /tmp/inspect.ts
pnpm lint:typed
pnpm architecture:patterns
pnpm check
```

The plan requires caller-authored behavior. Review its exact file bytes/digest,
add its profile and source-policy entries with an initial real test, and run the
guard. No empty tree or placeholder aggregate is generated. The plan does not
apply writes and grants no consumer mutation authority.

Required `check` runs coverage, typed lint, ast-grep, the existing Foundation
capabilities, and feature conformance. Fast checks include the ownership guard.
A failed prerequisite remains failure. The guard executes the existing source
parser/resolver, validates real runtime and type-only imports, and additionally
rejects reversed layers, deep feature imports, cycles, uncurated export-star
surfaces, behavior disguised as module assembly, empty layers and unowned files.
The local assembly extension admits imports, curated named exports, inert type
aliases derived from imported types/values, and direct calls or construction
through imported feature bindings. Wrapper parameters may supply explicit
dependencies. Arguments may contain literals, static property reads and literal
objects/arrays of dependencies. A factory may return its constructed value or
curated static member projections, including local aliases of those values.
An explicitly named wrapper may forward its unchanged parameters, in order, to
the same-named method of a constructed feature resource. A public class may
preserve its existing API with one readonly private feature delegate, assigned
once by its constructor through imported construction, and methods that only
return the same-named delegate call with unchanged parameters. It cannot inherit,
maintain additional state, transform arguments or select behavior. This permission
does not admit eager resource calls or calls to other members. Inline callbacks,
IIFEs, conditional/computed policy, getters and shadowed callable bindings fail.
Ordinary declarations and
policy remain valid inside their owning feature; this grammar applies only to
module assembly.

A primitive may declare a scalar error record that extends the intrinsic Error,
with one explicit scalar constructor parameter, a fixed matching name and at
most one readonly scalar payload field. Construction is limited to direct
throws; constructor aliases, exposed instances, additional methods, static
state, alternate bases and constructor policy are rejected. This exception
does not admit general classes or hidden mutable module state.

Only an exact manifest `bin` source may launch imported operations (`void` or
`await`), start resources, await readiness and stop/dispose them, including a
bounded `try/finally`. Signal registration and Promise completion handlers take
existing imported handlers; they cannot hide inline policy callbacks. This is a
finite wiring grammar, not a general JavaScript interpreter. More complex
orchestration belongs to a feature or requires an explicit local extension.

Workspace package permission does not grant inner-layer access to concrete
adapters or transport types. The guard reuses the Source Dependencies resolver
observations and manifest export matcher, then follows curated named exports,
imports and aliases to their feature/layer or exact primitive owner. A mixed
public root may expose a pure function/type and an adapter; importing the former
does not admit the latter. Namespace and dynamic imports must satisfy every
exposed binding. Missing, conflicting or cyclic binding ownership fails closed.
An integration adapter may consume another module's allowed public surfaces;
the stricter sibling-feature rule still applies inside its own module.
The existing source-policy `packageExports` claims remain authoritative and must
agree with the source projection; no second package permission catalog is added.

Manifest source targets include `.ts/.mts/.cts/.js/.mjs/.cjs` and JSX forms.
The local compiler projection maps `dist/*.js`, `*.mjs`, `*.cjs` and their
declarations to `src/*.ts`, `*.mts`, `*.cts`. Every projected public target must
be an exact public entrypoint. Conditional targets and bins receive the same
coverage; declaration files cannot be bins. Source wildcards fail, including
declaration wildcards. Non-source assets do not require source entrypoints.
This projection is source ownership, never proof of built artifact provenance.
The separate production quality gate still adopts only `.ts`; discovering other
extensions does not silently opt them into typed/ambient qualification.

Both `check` and `check:fast` must reach the feature and production-scope checker
through literal root pnpm script calls joined by `&&`, terminating in the exact
repository Node checker command. Full `check` must also reach the exact typed
runner and ambient scan terminals declared by `lint:typed` and
`architecture:patterns`; merely listing them in the profile is insufficient.
`check:fast` verifies connectivity and file selection without running typed lint.
The typed runner passes `--no-ignore` and `--disable-nested-config` to pinned
Oxlint. The scope guard compares that invocation's actual `--debug files`
selection with its counted source universe, including inherited configuration
exclusions. It does not implement Oxlint's ignore language. `.eslintignore`
cannot hide production files; a configured exclusion of counted source fails.
Echoes, successful short-circuits, failure
masking and opaque shell syntax fail. A failed prerequisite remains a failed
gate: `false && <gate>` is not a successful bypass. These static checks do not
replace trusted policy/CI review or prove execution of a consumer's checks.

The guard checks exact accepted decision evidence for primitive exceptions.
No repository primitive or cycle exception is currently accepted. It does not
infer semantic SOLID, aggregate correctness or security from names or metrics.

## Generated and primitive ownership contract

Semantic ownership and provenance are independent. A generated directory must
also belong to exactly one real feature layer through `features[].layers[].roots`.
Each `generatedRoots` record contains `root`, an existing repository `generator`
file, and nonempty existing `sources` paths. These identify rebuild inputs; they
do not execute the generator or certify fresh generated bytes. Generated code
keeps ordinary layer, dependency, cycle, entrypoint and quality checks. The
canonical managed assets are application-owned data; their bytes are unchanged.

An `exceptions` entry admits one exact pure technical file with `path`,
`role: "domain"`, `decision` and `consumers`. Each current consumer is an exact
`{ "path": "...", "owner": "module-id/feature-id" }` mapping. A public module
assembly consumer uses the explicit identity `module-id/@assembly`; a package
name alone is never a consuming feature identity. The checker derives each
owner from the existing profile, requires equality with the mapping, and checks
every caller against observed imports and re-exports, including type-only and
package surfaces. Unknown owners, duplicate paths, unmapped callers, stale
mappings and accepted identities without actual callers fail.

The accepted ADR's YAML frontmatter contains `primitiveScopes`, keyed by the
exact primitive source path. Each scope records nonempty `semantics`, `owner`,
`rationale`, `purity` (including interoperability obligations), `versioning`,
`reviewTrigger` and a unique closed `consumers` list of the actual module/feature
or explicit module assembly identities. These semantic facts belong in the
accepted decision; the mutable profile only maps current source paths. For
example, the shape of a fixture-only decision is:

```yaml
primitiveScopes:
  packages/example/src/ordinal.ts:
    semantics: Ordinal string comparison
    owner: platform-maintainers
    rationale: Duplicated ordering would break interoperability
    purity: Deterministic explicit inputs; no ambient or shared mutable state
    versioning: Successor decision and parity evidence for semantic changes
    reviewTrigger: Changed semantics, scope, ownership, versioning or consumer identities
    consumers: [example/alpha, example/beta]
```

A same-owner internal move changes the current profile mapping and ordinary
source policy/tests. It does not rewrite accepted ADR bytes. A new consuming
feature/module, changed primitive scope/semantics, ownership or versioning needs
a successor decision and its normal review/promotion procedure. The fixture
shape above grants no product primitive approval.

Primitive syntax admits literal scalar data, private literal object/array
tables read through scalar projections, and function-local working state.
Private literal regular expressions without `g` or `y` flags permit only direct
`test(value)` and `exec(value)` calls with one explicit argument. Their instances
and methods cannot escape or be aliased, exported, reassigned or recompiled;
optional/computed calls and spread arguments remain rejected. A direct
`throw new TypeError(message)` is admitted with one explicit argument, subject to
the same ambient-origin checks for its message. Error constructors and instances
gain no general alias, return or module-state permission.
Module-owned containers cannot escape through aliases, return values, exports,
arguments, spreads or destructuring. Writes, mutating methods, getters, computed
initializers and unknown module initializers (including factories and mutable
collections) fail conservatively. Only static nested data projections and literal
table indexes are recognized; unknown keys could expose prototype objects or
methods. Arbitrary method purity and state flow
are not inferred. Directory/wildcard exceptions, reverse feature imports and
ambient operations remain forbidden. Source-policy permissions and cycle
rejection still apply; primitive admission grants no IO or adapter access.

The primitive guard uses the same transparent expression grammar for initializers,
scalar reads, call references and write targets: parentheses, `as`, angle-bracket
assertions, non-null assertions and `satisfies`, including nesting between member
projections. Assignment, update, delete and destructuring targets remain writes
through those wrappers. Type syntax does not grant runtime purity.

Ambient origins follow lexical bindings through function-local `const` aliases,
static dot/literal-key members and closed static object destructuring, with a
64-binding resolution limit that fails closed. Real parameters and local values
shadow ambient names. Module functions remain module-owned objects: only direct
calls and curated exports are admitted; their state cannot escape through aliases
or reflection. Module table aliases and container escapes remain rejected.

The finite ambient call grammar admits scalar conversions (`Number`, `String`,
`Boolean`, `BigInt`, `parseInt`, `parseFloat`, `isFinite`, `isNaN`), Number's
`isFinite/isInteger/isNaN/isSafeInteger/parseFloat/parseInt`, String's
`fromCharCode/fromCodePoint`, `Array.isArray/of`, `Object.is/keys/values/entries/hasOwn`,
`JSON.parse/stringify`, and the exact deterministic Math operations and numeric
constants enumerated in `scripts/feature-modules/purity.mjs`. Aliasing a container
or static function does not widen this list or permit returning, storing or
passing it to another function. Arbitrary ambient globals fail closed.

`Object.assign/defineProperty/defineProperties/freeze/seal/preventExtensions`
and `Reflect.set/deleteProperty/defineProperty/preventExtensions` require a direct
object/array literal or its local `const` alias chain as their first argument,
created in the same function invocation. Arity is checked; `Reflect.set` supports
exactly three arguments, without a separate receiver. Local property/array
mutation remains admitted. Reflection on module, ambient, parameter, factory
result or otherwise unknown targets fails; fresh results are not inferred from
arbitrary calls or member reads. All other reflection (including `Reflect.get`,
prototype access, `apply`, `construct`, and `call/apply/bind` on builtin aliases),
dynamic operation keys, optional calls, spread arguments and mutable/default/rest
ambient aliases fail conservatively. These are bounded state-origin rules, not
interprocedural purity analysis or a replacement for the composed Oxlint rules.

One qualified pure builtin operation is accepted in inner layers:
`createHash("sha256").update(explicitBytes).digest("hex")`, including a renamed
named import and an explicit UTF-8 update encoding. Every use of that binding
must be the complete chain. Random operations, crypto namespaces, escaped hash
factories and unknown algorithms/operations remain rejected. This preserves
fixed-byte hashing without inventing an IO port for deterministic computation.
Purity checks are bounded prohibitions backed by semantic review, not a proof
that arbitrary JavaScript is pure.

ADR-0047 remains reserved for the coordinator's exact primitive decisions.
Source owners must provide exact primitive scopes, actual consumer identities,
current caller mappings and parity evidence for
ordinal comparison, SemVer, canonical/strict JSON and any justified path
identity primitive. Cancellation still needs its reporting owner settled first.
Neither test-fixture ADRs nor ADR-0046 approve those product exceptions. Existing
accepted ADRs, standards, schemas, journals and release baselines stay immutable;
supported export changes require their normal compatibility/promotion procedure.

## Known gaps and migration ownership

- Root utilities in Foundation, Authoring and Mutation still need semantic owners
  or a separately justified primitive decision. The profile leaves them
  unowned; a `core` or `runtime-primitives` feature would conceal the gap.
- Authoring's `document-authoring.surface` and MCP's
  `docs-protocol-mcp.surface` source-policy boundaries span layers. Their owners
  must split boundaries and curate internal APIs without changing released
  exports or persisted recovery bytes.
- Existing capability internal entrypoints expose individual implementation
  files; application-to-assembly dependencies and feature graph cycles require
  narrow APIs and real owner decisions. Module CLI/config orchestration must
  become feature-owned behavior with thin assembly.
- Docs Protocol application parsing (`application/compiled-document.ts`) and
  search (`community/context/minisearch-adapter.ts`) require owned ports/adapters. Existing
  source-policy permissions are not proof of Clean Architecture. Its owning
  lane must perform parity-qualified extraction; this lane reports the edges.
- Expanded typed lint exposes existing violations in other owners' source.
  Fixes are required before integration readiness; thresholds are unchanged.

Run the feature checker for deterministic JSON with every current failing path
and edge. Handoff evidence separately captures quality failures and untouched
source hashes. These are required bounded migrations, never accepted exceptions
for scheduling or concurrency. Coordinator full verification and registry E2E
apply to the integrated SHA after these gaps are resolved.
