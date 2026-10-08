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

Version `0.1.0-rc.0` is published. Runtime adopted the public import in
[PR #213](https://github.com/agent-teams-ai/agent-runtime/pull/213); Central in
[PR #357](https://github.com/agent-teams-ai/.github/pull/357). Central's conformance
wrapper is not a live authenticated merge authority. Imports do not resolve
independent current-H, source-authority or FULL-recovery gaps.

The package is import-only ESM for its declared Node 24/26 engines, with no
CommonJS fallback. A Social Monitor Node upgrade alone does not qualify Jest ESM.
See the integration guide below for collector closure, affected selection,
evidence reuse and fail-closed rules.

The next minor narrows `InputLeaf` to a discriminated type/mode union. Construct
file `100644`/`100755`, symlink `120000` or gitlink `160000` leaves together;
narrow dynamic types before choosing modes rather than asserting a broad record
as `InputLeaf`. Runtime validation still accepts `unknown`. This type migration
does not change runtime behavior or authorize publication or new omission policy.

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
be executable without the failed optimizer; a fallback branch alone is no proof.

Qualify a consumer's rejecting adapter cases on a disposable TEST project before
widening policy: helper/config drift, incomplete collection, unknown inputs and
unavailable optimizer. Keep source-authority and independent-H gaps explicit.
For Social Monitor, upgrading Node is only a prerequisite: separately qualify
the actual ESM tooling entrypoint and Jest integration. No CJS fallback is assumed.
