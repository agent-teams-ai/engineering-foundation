# Native public API tool transition

The existing `public-api-promote-release` command supports one explicit tool
transition: API Extractor `7.58.12` to `typescript-native/7.0.2`. Ordinary checks
and promotion without this input retain their tool-mismatch refusal. This
operation changes no SDK-growth authority, consumer package scope, baseline
anchor, accepted decision, historical evidence or publication authority.

## Commands and ownership

```sh
agent-teams-foundation public-api-promote-release --consumer . \
  --native-transition /temporary/acquired/request.json --qualification-only --format json
```

This invocation is read-only with respect to released baselines. It emits a
separate native qualification result. It does not replace, filter or relabel the
ordinary full check's report or exit code. A consumer wrapper retains that
original report and accepts only its exact reviewed tool mismatch alongside a
successful native comparison. Unrelated ordinary failures remain failures.

After the reviewed upgrade reaches the owning trusted release operation, run
the same command without `--qualification-only`. Changesets versioning and the
normal declaration build precede promotion. All ordinary native compatibility,
version, exact breaking-fingerprint, accepted-decision and artifact policies
still run. Every destination is preflighted before any baseline write. The
leased writer retains actual physical B bytes as its preimage; the native
historical A is used only for the semantic comparison. Replay accepts only the
reviewed B or the exact computed postimage, including paths already complete.
Multiple file replacements are not one atomic transaction.

The consumer owns archive origin authentication, original source/configuration
custody, the frozen dependency namespace, independent review of the entire B-to-A
difference, and its trusted release execution. Neither a request field nor a
successful local qualification grants write authority. The command verifies
content and does not authenticate a GitHub commit or registry origin merely
because a caller names it. Existing repository release controls remain required.

## Versioned content request

The strict schema is `package-public-api-native-transition/v1`. Existing schema
versions are unchanged. A request has the following shape:

```json
{
  "schemaVersion": 1,
  "kind": "foundation:public-api-native-transition:1",
  "releasedRoot": "historical",
  "review": {
    "kind": "foundation:public-api-native-migration:review:1",
    "from": "7.58.12",
    "to": "typescript-native/7.0.2",
    "baselineSourceCommit": "0000000000000000000000000000000000000000",
    "policyDigest": "sha256:<64 lowercase hexadecimal digits>",
    "toolDiffDigest": "sha256:<64 lowercase hexadecimal digits>",
    "packages": [
      {
        "packageName": "@example/library",
        "baselinePath": "architecture/public-api/library.json",
        "baselineDigest": "sha256:<original raw B bytes>",
        "archiveDigest": "sha256:<exact archive bytes>",
        "archiveIntegrity": "sha512-<exact archive SRI>",
        "configDigest": "sha256:<original package configuration bytes>",
        "releasedInputsDigest": "sha256:<complete captured historical namespace>",
        "nativeReleasedDigest": "sha256:<actual native A snapshot>"
      }
    ]
  },
  "packages": [
    {
      "packageName": "@example/library",
      "baselineInputPath": "inputs/library.baseline.json",
      "archivePath": "inputs/library.tgz",
      "configPath": "historical/packages/library/tsconfig.json"
    }
  ],
  "configurationFiles": [
    {
      "path": "tsconfig.base.json",
      "inputPath": "historical/tsconfig.base.json"
    }
  ]
}
```

The placeholders illustrate fields, not usable digests. Every path is relative
to the request's directory and contained there. `releasedRoot` is an ordinary
directory disjoint from the candidate checkout. Input files cannot come from the
candidate namespace. Symbolic-link inputs, traversal, special archive members,
portable name collisions, extra historical files and incomplete package/export
inventories reject. The archive reader retains the existing 8 MiB compressed,
16 MiB member and 64 MiB aggregate bounds. Historical archives admit at most
2,657 entries, the actual largest historical archive in the two real transition
cohorts (published Foundation 1.9.0).

The historical namespace contains only exact archive contents at the policy's
package roots, original package configurations, explicitly listed extra JSON
configuration, and frozen dependency data under `node_modules`. Dependency
command links in `.bin` are not compiler inputs; other dependency symbolic links
reject. All historical JSON/declaration resolution inputs are captured and
hashed. Acquisition must finish and exclude other writers before observation;
content checks are not a sandbox against hostile same-user processes.

The policy, request, observation and review must describe the same complete,
unique package inventory. Both canonical baseline anchors and every exported
entrypoint remain covered. The command recomputes A and C, checks the exact
complete B-to-A packet, then independently evaluates A-to-C. It rejects identity,
kind, parent or export loss. Reviewed signature changes remain explicit; the
operation supplies no normalization or semantic waiver.

## Result

Read-only compatibility diagnostics are retained even during release promotion.
For example, an unchanged API with an advanced package version produces the
ordinary check-stage baseline-version diagnostic. The release operation does not
filter that report: the existing promoter separately validates the advanced
version, Changeset and accepted-decision rules before any write.

The JSON result has `schemaVersion: 1` and
`kind: foundation:public-api-native-transition:result:1`. It includes the full
actual `observation`, its digest, the content-review digest and the write plan.
Qualification returns `outcome: qualified`, `migrationApplied: false` and an
empty `writes` array. Promotion returns `outcome: promoted` and the actual
planned replacements. A replay may have an empty write plan. Neither result
claims an ordinary check pass, authenticated external custody, G1 activation,
completed aggregate qualification or publication.

Foundation's fixed eight-package wrapper retains its original source, archive,
GitHub/npm and immediate protected-release checks. It delegates to this same
operation. Consumer wrappers own their own exact inventory and origin receipts;
Foundation contains no Get Modular package catalog or consumer architecture.
