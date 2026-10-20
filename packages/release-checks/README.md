# Release Checks

Development/CI-only, deterministic comparison of accepted release inputs, an
exact engine plan and an independently observed candidate. The package has no
runtime or peer dependencies, filesystem/network/process access, hashing,
Changesets implementation or merge/publication authority. Do not import it from
product runtime code.

The exact repository-catalog TypeScript compiler is a development-only build
input. Existing clean package qualification snapshots that compiler and its
native closure. Installing this package as a dependency installs neither the
compiler nor a parser; both public entrypoints retain an empty runtime closure.

Changesets remains the version and dependency-propagation engine. The Host
freezes its official plan, independently observes the result, then calls:

```ts
import { checkReleaseCandidate } from '@agent-teams/release-checks';
import type { ExpectedInputs, ObservedCandidate } from '@agent-teams/release-checks';

function check(expected: ExpectedInputs, observed: ObservedCandidate) {
  return checkReleaseCandidate({ schemaVersion: 1, expected, observed });
}
```

The `unknown` runtime boundary returns a coded rejection for malformed inputs.
Types describe the accepted version-1 shape; they do not authenticate supplied
facts. The initial `0.0.0` source admission is not evidence of a supported public
npm release. Consumers adopt the exact supported coordinate qualified by their
release record.

## Contract and ownership

| Input | Required facts |
| --- | --- |
| `expected.binding` | Portable immutable source identity/digest; exact engine identity/digest; config, inventory, policy, intent-set and frozen-plan digests |
| `expected.packages` | Nonempty complete inventory of actual packages, including a root `package.json` when present; unique name/root/path, public/private visibility, version eligibility and full accepted manifest snapshot |
| `expected.intents` | Complete qualified source intent identities/paths/digests, pending/retained participation and explicit requested package/type pairs |
| `expected.plan` | All official normalized release records, including dependent and unchanged `none` records; exact old/new versions and direct intent links; explicit qualified consumption effects |
| `expected.permittedChanges` | Exact path, classification, change kind, before/after type/mode and named Host content authority |
| `observed.binding` | Independently re-observed portable input identity; never copied merely to make the comparison pass |
| `observed.manifests` | Independent complete manifest inventory and full before/after semantic and byte-identity snapshots |
| `observed.consumptions` | Independently observed intent identity, original digest and effect |
| `observed.diff` | Complete independently enumerated candidate changes, with exact before/after leaf identity and absence |

The complete public types are exported from the root. All source roots and paths
are relative to the Git repository root, even when the engine runs in a nested
directory. A repository need not have a root package manifest. Source roots use
`.` only for an actual repository-root package, with `package.json` as its manifest. Other paths are
literal relative slash-separated paths: no empty/dot/dot-dot segments,
backslashes, drive prefixes or ASCII controls/DEL. Case and Unicode spelling
retain their identities. The library does not canonicalize filesystem paths.

Every digest uses `sha256:` plus 64 lowercase hexadecimal characters. Leaf
type/mode pairs are file `100644`/`100755`, symlink `120000`, and gitlink `160000`.
Manifest and consumed intent files must be ordinary nonexecutable files. Host
outputs may use only the exact type/mode admitted by their permission. Renames
and copies are observed as their actual added/deleted paths by the Host.

`null` before/after leaves mean file absence. A planned `null` version means
an absent manifest version property, allowed only for qualified private,
non-versioned inputs. A literal manifest `"version": null` rejects. A present
version is compared as an exact nonempty string; this package neither parses
SemVer nor judges bump adequacy.

The Host owns authenticated source/PR/CI facts, actual filesystem/Git census,
resolved source root and Git directory, engine working directory and exact
installed entrypoint. Physical checkout paths remain in Host-local custody
evidence, so independent legitimate PR qualification can use another checkout.
The Host hashes raw bytes and binds semantic snapshots to those byte digests.
The checker compares supplied hashes; hashing serialized semantic JSON would
not identify the original file bytes.

## Version-only manifest relation

Every classified manifest must be present in the observed inventory. Source
identity, public/private classification and before snapshot must agree.
Observed old/new versions must equal the complete frozen plan. An engine-derived
dependent release can have empty `intentIds`. An unchanged `none` record must
remain in the plan and need not produce a changed file.

All semantic manifest fields except the exact planned version remain equal.
Arrays retain their order; object key insertion order is irrelevant. Scripts,
exports, dependencies, unknown fields and nested values cannot change through a
permitted classification label. A manifest byte change without a planned actual
version edit also rejects. Snapshot leaf identities and actual modified-file
diff entries must agree.

Version eligibility (`versioned`, `unversioned`, `ignored`) and visibility
(`public`, `private`) are separate qualified Host facts. Each eligible pending
request needs its reciprocal direct plan link and planned consumption. Retained
intents do not acquire new release or consumption requirements. The checker
does not infer those classifications from raw engine configuration.

There is no dependency-rewrite API in version 1. The supported consumers use
qualified symbolic workspace ranges or retain their stricter peer-floor policy.
A required rewrite rejects until its owning contract/admission changes; do not
describe it as a generic permitted manifest edit.

## Consumption and no release

`remove` requires an exact deleted intent path whose before digest equals the
source intent. `record` requires an admitted changed metadata file and an
unchanged retained intent file. This supports Foundation's existing prerelease
bookkeeping without adding a new release lane. Existing Host guards must still
validate the metadata's meaning, unchanged changelog history, generated entry,
consumed summaries, API baselines and lock behavior. `contentAuthority` names
that owner; it is not executed by this package and grants no permission itself.

Qualified empty housekeeping intents may be consumed alongside a real release.
Ignored/non-versioned private intents remain retained. A plan with no actual
old/new version edits, including a plan containing unchanged `none` records,
must have no consumption or source-tree mutation. The Host ends a passed
no-release state without invoking version or waiting for a branch/PR.

## Reports and bounds

`CheckReport` is a frozen `passed`/`rejected` union with schema version 1,
stable diagnostic codes and normalized observed package changes. Codes carry
package/path/intent identity where applicable. Ordering is case-sensitive by
package name, path, code, intent ID and message; package changes use name/path.
Input/identity validation rejects before ambiguous semantic comparisons.
Successful reports and nested report collections retain no caller references.

Inputs are bounded ordinary JSON records/arrays and finite scalar values. The
request allows at most 262,144 traversed values, 8,388,608 total key/string code
units, nesting depth 64, and 65,536 array elements; identity/path strings have at
most 4,096 code units. Cycles, sparse arrays, accessors, symbols, non-enumerable
record fields, custom prototypes, unsupported versions and unknown contract
fields reject. Plain and null-prototype records are accepted. Executable Proxies
and modified JavaScript intrinsics are outside the input contract.

A passed relation proves no authentication, completeness of an externally
supplied census, truthful engine execution, successful Host content guard,
required CI/review, package admission or permission to merge/publish. Those
owners must independently enforce their existing boundaries.

## Shared conformance data

The deliberate `./conformance` entrypoint exports immutable, independently
expected data and its `ConformanceCase` type. It exports no test runner or
framework integration:

```ts
import { checkReleaseCandidate } from '@agent-teams/release-checks';
import { releaseCandidateConformanceCases } from '@agent-teams/release-checks/conformance';

for (const entry of releaseCandidateConformanceCases) {
  const actual = checkReleaseCandidate(entry.input);
  // Consumer assertions compare outcome, ordered codes and packageChanges
  // with entry.expected using the consumer's own test framework.
  console.log(entry.id, actual.outcome);
}
```

The common data covers direct/dependent releases, mixed empty housekeeping,
unchanged private `none`, retained-file consumption, nested packages without a
root manifest, no release and targeted
rejections. Each adopting Host also qualifies its own actual engine, complete
observations, content guards and installed exact package. Do not generate both
the plan and its expected answer with checker code.

Foundation source-builds this leaf and calls it at the actual generation,
pre-baseline-mutation and current-head/base qualification seams. Old partial
content helpers retain their content/prerelease responsibilities; they do not
manufacture a complete request from candidate versions. Consumers use a pinned
public development dependency and the same exported operation.
