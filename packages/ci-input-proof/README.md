# CI Input Proof

Development/CI-only pure inventory comparison. Do not import this package from
product runtime code. There are no runtime dependencies, I/O, hashing, cache,
Get Modular dependency, execution receipts or merge authority.

```ts
import { compareLeafInventories } from '@agent-teams/ci-input-proof';

const relation = compareLeafInventories(before, after, permittedContentChanges);
```

The Host independently constructs complete inventories and classifies leaves.
Each inventory has exactly `version: 1`, `digestScheme`, and `inputs`. Each leaf
has exactly `path`, `type`, `mode`, `membership`, and `content`. Modes are
file `100644`/`100755`, symlink `120000`, gitlink `160000`; membership is
`closed` or `structural`. Schemes are `git-object-sha1` (nonzero lowercase
40-hex OID) and `sha256` (nonzero lowercase 64-hex digest), without conversion.

Inputs are plain or null-prototype own-data records and stock dense arrays.
Accessors, custom iterators, symbols, extra fields and holes reject without
calling a getter or iterator. Executable Proxies and modified intrinsics are
outside the contract. Inventories have 1–65,536 leaves and at least one closed
leaf. Literal relative paths have at most 4096 code units, no empty/dot/dot-dot
segments, backslashes, absolute drive prefixes or ASCII controls/DEL. Case and
Unicode spelling retain their identity; no filesystem canonicalization occurs.

Both inventories must have the same path set, type, mode and membership.
Closed content cannot change. Structural content may change only for an exact
permitted existing structural path. Permissions are a dense unique path list,
bounded by the leaf count; extra permissions for closed/missing leaves reject.

`compatible-inputs` returns frozen ordinal `changedContentPaths` for actually
changed permitted leaves, including an empty array for equal inventories.
`rejected` returns a frozen stable reason. Validation order is before inventory,
after inventory, scheme equality, permissions, structure, then content. Results
retain no caller references. A compatible relation proves neither semantic
completeness, authentication, successful tests, eligibility nor permission to
omit a check. Runtime-specific narrower eligibility remains consumer-owned.

The published `0.1.0-rc.0` predecessor remains historical evidence. Runtime
adopted the public import in [PR #213](https://github.com/agent-teams-ai/agent-runtime/pull/213); Central in
[PR #357](https://github.com/agent-teams-ai/.github/pull/357). Central's conformance
wrapper is not a live authenticated merge authority. Imports do not resolve
independent current-H, source-authority or FULL-recovery gaps.

The package is import-only ESM for its declared Node 24/26 engines, with no
CommonJS fallback. A Social Monitor Node upgrade alone does not qualify Jest ESM.
See the integration guide below for collector closure, affected selection,
evidence reuse and fail-closed rules.

### InputLeaf type migration

`InputLeaf` is a discriminated type/mode union. Construct file
`100644`/`100755`, symlink `120000` or gitlink `160000` leaves together; narrow
dynamic types before choosing modes rather than asserting a broad record as
`InputLeaf`. Runtime validation still accepts `unknown`. Migrating from the
published `0.1.0-rc.0` type requires replacing broad `type`/`mode` records with
these matching discriminated pairs. This type migration does not change runtime
behavior or authorize new omission policy.

## Integration guide

Use the public root from development/CI tooling through static ESM imports on
the declared Node 24/26 engines. This fixed library dependency is not a new Get
Modular graph node. The consumer owns collection, policy and execution; the
package owns only the bounded relation. Do not add a scheduler or receipt Host.

Before permitting one omission, name its exact command and scope. Collect the
complete discovery closure: source, transitive helpers, fixtures, generated/API
inputs, selection rules, configuration, lockfile and installed dependency graph.
Bind compiler/test toolchain, installation policy and relevant environment to
consumer admission even when they are not represented as content leaves.
Materialize before/current facts once per observation boundary; compare in
memory rather than scanning Git, installed files or the network for each scope.
Classify closed inputs independently and permit only exact existing structural
paths whose changes the accepted policy allows. Candidate declarations cannot
authorize their own collector, input exclusions or omission policy.

### Affected selection

For `pnpm test --filter parser`, suppose a complete admitted tree contains
`parser.ts`, its shared helper and fixtures as closed inputs; only an unrelated
documentation body is permitted structural content. The independently collected
before/current inventories can have this minimal shape:

```ts
import { compareLeafInventories, type LeafInventory } from '@agent-teams/ci-input-proof';
const before: LeafInventory = { version: 1, digestScheme: 'sha256', inputs: [
  { path: 'parser.ts', type: 'file', mode: '100644', membership: 'closed', content: '1'.repeat(64) },
  { path: 'docs/usage.md', type: 'file', mode: '100644', membership: 'structural', content: '2'.repeat(64) },
] };
const current: LeafInventory = { version: 1, digestScheme: 'sha256', inputs: [
  { path: 'parser.ts', type: 'file', mode: '100644', membership: 'closed', content: '1'.repeat(64) },
  { path: 'docs/usage.md', type: 'file', mode: '100644', membership: 'structural', content: '3'.repeat(64) },
] };
const relation = compareLeafInventories(before, current, ['docs/usage.md']);
```

These inert values illustrate the relation, not a complete collector. A compatible
result with `docs/usage.md` changed allows affected selection only under that
consumer's admitted policy; it does not say parser tests passed on current H.
Changing the shared helper, fixture, selection config or toolchain must execute
the affected test. Adding/deleting/renaming a leaf or changing type/mode/membership
rejects rather than widening selection. Report omission separately from PASS.

### Reuse a previous successful qualification

For an installed package's Linux Node 24 qualification, obtain authenticated
successful evidence and independently collect its complete old/current input
closure, including package/archive identity and installed graph. Compare with
`compareLeafInventories(previousInputs, currentInputs, [])` and require both
`compatible-inputs` and empty `changedContentPaths`. Independently match scope,
OS/Node/toolchain/environment, source origin, workflow and attempt identity.
An equal inventory with missing success evidence cannot justify reuse. A Linux
Node 24 PASS cannot qualify Windows or Node 26; a new head/base/merge-group cannot
inherit an old SHA PASS merely because submitted fields claim a match.

### Reject uncertainty

Symlink content identifies the link, not target bytes; gitlink content identifies
a commit pointer, not dirty submodules or recursively available inputs. Either
collect the relevant target closure under a reviewed policy or execute the check.
Paths are literal case/Unicode identities. The collector admits actual checkout
behavior on each OS; it must not normalize collisions or omit unsupported paths.
Missing history, incomplete census, unsupported count/scheme/path, import failure
or collector failure means independent FULL execution or fail closed. FULL must
be executable without an optimizer; a fallback branch alone is no proof.

Qualify a consumer's rejecting adapter cases on a disposable TEST project before
widening policy: helper/config drift, incomplete collection, unknown inputs and
an unavailable optimizer policy. Keep source-authority and independent-H gaps
explicit.
For Social Monitor, upgrading Node is only a prerequisite: separately qualify
the actual ESM tooling entrypoint and Jest integration. No CJS fallback is assumed.

### Installed public-root reference

The concrete typed TEST reference at
`tests/fixtures/ci-input-proof/foundation-pilot.TEST.mts` imports only
`@agent-teams/ci-input-proof`. Strict CI-tooling typechecking covers its source
shape through the narrow test path mapping; packed qualification copies the same
fixture into a disposable consumer and typechecks it against the installed public
export. There is no duplicate source-only example. The source suite does not
execute the public-root fixture. The installed disposable consumer is the
supported runtime execution boundary. The reference constructs file, symlink and
gitlink leaves as
discriminated pairs and includes compile-time rejecting pairs for every mismatched
mode. The packed qualification copies that reference into a disposable consumer,
installs the exact file tarball, reads the trusted source manifest and installed
manifest, and rejects any package-name/version contradiction. The expected
identity is therefore the current source version rather than `0.0.0`, so an
ordinary successor version bump remains testable. It runs the repository's
exact installed TypeScript `7.0.2` compiler against the installed public export
and reports the compiler identity. The packed toolchain first installs the exact
current-platform native TypeScript package archive, then installs the TypeScript
meta package and CI Input Proof tarballs through the same offline store. The
installed platform manifest and native compiler bytes must match the repository
toolchain before TypeScript's real public export and compiler are exercised; no
type stub or substitute compiler is admitted. A deep package import is expected
to fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

### Published install

Use the consumer's supported package manager and retain its reviewed pin. For an
existing pnpm consumer tooling workspace, substitute the workspace selector and
the exact version from the approved manifest/registry release record:

```bash
export CONSUMER_TOOLING_WORKSPACE='<existing-consumer-tooling-workspace>'
export CI_INPUT_PROOF_VERSION='<exact-released-version>'
pnpm --filter "$CONSUMER_TOOLING_WORKSPACE" add --save-dev --save-exact \
  "@agent-teams/ci-input-proof@$CI_INPUT_PROOF_VERSION"
```

This records `@agent-teams/ci-input-proof` as an exact development-only
dependency through ordinary registry installation. The exact manifest and
registry release record controls availability and version; this guide does not
claim that a successor is already published. No local archive, test fixture or
temporary token is required.

The consumer tooling workspace must declare Node `^24.18.0 || ^26.0.0` (or a
supported narrower range), retain a supported pnpm `>=11.17.0 <12` pin, and use
ESM through `"type": "module"` or an ESM tooling entrypoint. There is no
CommonJS fallback. Use the existing [typed example](#affected-selection) and
[`InputLeaf` migration](#inputleaf-type-migration) rather than copying duplicate
code.

### Disposable file-tarball artifact qualification

The following local-archive JSON is not an ordinary published-install recipe.
It is retained only for the existing disposable file-tarball artifact
qualification; the source-only TEST reference above is not required for the
registry quickstart.

```json
{
  "type": "module",
  "packageManager": "pnpm@11.20.0",
  "devDependencies": {
    "@agent-teams/ci-input-proof": "file:/absolute/path/to/ci-input-proof.tgz",
    "@types/node": "24.13.3",
    "typescript": "7.0.2"
  }
}
```

Keep the disposable qualification consumer's compiler options in a separate
`tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "strict": true,
    "target": "ES2024",
    "verbatimModuleSyntax": true
  }
}
```

### Bounded Foundation pilot

The pure comparator contract is cross-platform. This specific Foundation pilot
and its selected RC target are Linux-only and reject other pilot platforms.
`scripts/ci-input-proof-foundation-pilot.mts` is a concrete shadow pilot for the
bounded Foundation CI Input Proof RC qualification group
`tests/ci-input-proof-rc.test.mts`, including its real archive preparation and
installed public-root probe. It is not a scheduler, universal collector, receipt
service or Get Modular graph node. The collector has one explicit fixed scope
with nonempty source, helper, fixture, configuration, lock, toolchain and
installed-graph categories, including the RC preparation script and package
archive inputs. Its installed-graph basis is the lock/package-map identity and
the package's exact exported build files. Nonempty runtime dependencies,
symlink-target closure and other package-resolution forms are unsupported:
collection reports the failure and the independently configured FULL command
still executes. The pilot is `control-shadow` evidence from two boundaries over
one tree with a caller-supplied tuple. It does not establish independent B/H
collection, complete package-resolution closure, current-head qualification or
saved CI work.

Run the normal package build and preparation boundary before this pilot:

```bash
pnpm build
node scripts/prepare-package.mjs
```

`prepare-package.mjs` prunes stale distribution output and materializes each
publishable package's normal generated `LICENSE` from the repository root. The
pilot's fixed scope includes that prepared package input. Without this
preparation, collection is incomplete and cannot produce a positive candidate
observation; the independently configured FULL process still executes or fails
closed.

Each logical fact is materialized once per before/current observation boundary,
then the real target executes:

```bash
node scripts/ci-input-proof-foundation-pilot.mts \
  --head 0000000000000000000000000000000000000000 \
  --base 1111111111111111111111111111111111111111 \
  --merge refs/heads/TEST-ci-input-proof
```

The JSON report binds a digest of the supplied head/base/merge tuple and records
before/current collection, comparison and FULL timings. `timingObservation`
reports collection overhead and, only when the relation is equal, the potential
FULL duration that a future admitted policy might avoid; it grants no omission
or PASS authority. The optimizer is a reported-unavailable observation with no
process protocol and no omission authority. The selection decision is always
`full` in this rollout. Even an equal-inventory `candidateOmitObservation`
executes FULL. Omission is always `not-attempted` and is reported separately from
the target process PASS. Caller JSON, labels and report constants cannot admit
omission. Preserve the repository's complete FULL matrix, hosted technical
review and reviewed merge operator unchanged.

### Get Modular and Social

This package is a fixed development/CI dependency reached only through static
ESM imports from tooling. It never enters product runtime code or a runtime
dependency graph, and it adds no Get Modular component or lifecycle. The
maintained [CI Input Proof source admission](../../docs/development/ci-input-proof-admission.md#modularity-and-checks)
owns the Consumer Module Standard pin, retained provenance and packet evidence;
no private `.cache` packet is a public prerequisite.

Social Monitor support is staged: the owner-requested Node upgrade comes first,
then the actual Node 24 ESM tooling entrypoint and Jest integration receive
separate disposable TEST qualification. Adoption does not force a Jest rewrite,
does not add a CommonJS fallback and does not claim that a Node upgrade alone
qualifies Jest ESM.

### Pins, migration and support checklist

| Item | Exact support |
| --- | --- |
| Node | repository `.node-version` `24.21.0` for this rollout; package engines `^24.18.0 || ^26.0.0` |
| pnpm | package range `>=11.17.0 <12`; this repository pins `pnpm@11.20.0` |
| TypeScript | repository catalog pin `7.0.2` |
| Package dependencies | no runtime dependencies; no floating dependency ranges |
| Module format | ESM public root only; no CommonJS fallback |
| Historical published predecessor | `0.1.0-rc.0`; successor availability follows the exact manifest/registry release record |

Before enabling any consumer omission:

- independently admit the exact check command and bounded scope;
- close source, helpers, fixtures, configuration, lockfile, toolchain,
  installation policy and installed dependency graph;
- collect before/current facts once per observation boundary on each supported
  OS and Node version;
- prove FULL succeeds and fails through independent real processes without the
  optimizer;
- keep unsupported, incomplete and structural drift on the executable FULL route;
- bind current head/base/merge identity and retain independent technical review;
- run the complete requested `full-ci` matrix and preserve merge authority.

Until every applicable item is satisfied, the supported behavior is shadow with
actual FULL execution. No mass omission is claimed.
