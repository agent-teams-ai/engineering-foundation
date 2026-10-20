# Release Checks implementation qualification

Status: Foundation source implementation and focused qualification complete;
independent final-head review and the required full CI remain pending. Public
admission remains unmerged until the existing npm provider-readiness gate is
established. Publication and external adoption are not completed by this record.

The [delivery plan](../development/release-checks-delivery-plan.md) passed its
three sequential improvements and three sequential critical reviews before
implementation. [Their record](release-checks-plan-review.md) retains the actual
reviewed revisions and ten material findings. This file records implementation
qualification separately.

## Implementation corrections

| Observed issue | Correction and verification |
| --- | --- |
| Clean artifact stages need an explicit compiler development input | Reused the exact TypeScript catalog declaration and existing compiler custody; two actual clean builds and installed consumers prove the compiler is not a runtime dependency |
| The conformance declaration referred to two types not exported from that entry | Re-exported its already root-public `DiagnosticCode` and `PackageChange` types; native extraction and installed declaration compilation passed |
| A normalized `none` record could carry different old/new versions | Both the official-plan normalizer and pure boundary reject that contradiction; retained engine and pure counterexamples passed without computing a version |
| Native executable bytes are specific to the operating system | Portable engine binding uses the runtime version and package contents; local custody retains actual paths and native executable hash; copied-installation and independent-base tests passed |
| Reusing the retained files-policy module during its top-level CLI await deadlocked | Completed module initialization before running the CLI, with explicit fatal error handling; the actual files CLI passes valid engine output and rejects a forged Bun lock SRI |
| The normal all-package API promoter encounters a pending earlier public API addition | Created only the new initial anchor through the existing native promotion owner; kept the full production policy and verified all nine typed/artifact surfaces and all 13 unchanged historical baseline hashes |
| Complete source coverage found the new package missing from suppression governance | Added its complete source root to the existing governed roots; no waiver or suppression was added |

No generic release manager, compiler-stage exception, public Foundation facade,
new publisher or version-selection algorithm was added.

## Executed local qualification

These are actual pre-commit source checks. The final required native CI must
qualify its own exact head/base and cannot reuse these as hosted receipts.

| Boundary | Observed result |
| --- | --- |
| Pure core and shared conformance | 20 tests passed with normal Node process isolation |
| Actual-engine Foundation Host | 5 integration tests passed, covering frozen plans, pre-baseline checks, independent base reconstruction, complete diff and execution drift |
| Retained release, freshness, bootstrap and migration routes | 118 tests passed; final collector/registry delta suite passed 16 tests |
| Authentic pinned action/Changesets lock fixture | Actual Changesets 2.31.1, Bun 1.4.3, pnpm 11.20.0 and Node 26.11.1 passed generation and source/lock checks; the FMS peer floor was preserved and a forged Bun SRI rejected |
| Admission and catalog authorities | 68 tests passed; nine-package release, source and feature inventories and complete 338-test/eight-shard manifests passed |
| Installed package | Two byte-identical clean-stage archives; offline packed and no-uplink registry consumers passed TypeScript 7.0.2 declarations and all ten public common cases |
| Initial API evidence | One new initial anchor; complete nine-package typed/artifact check passed; 13 historical baseline files unchanged |
| Workflow security | Required pinned workflow security command passed with no new findings or suppressions |
| Required pre-PR source gates | `bun tools/dev.mts check:changed` passed its complete `fast-full` selection against the original accepted base; the separate `bun tools/dev.mts check:fast` also passed after complete suppression-governance admission |

The retained [installed qualification](evidence/release-checks/p1-installed-qualification.json)
binds archive SHA-256
`5c468f1721ceb04d1c909b0c6c2fc42167496f7e60703fea0dfc0a094a14fdd7`.
This is candidate `0.0.0` from local clean stages and a local registry; it is not
the protected Ubuntu publication writer, a public npm release or E2E completion.
The [initial API record](evidence/release-checks/p1-initial-api-baseline.json)
retains the exact new write and all old baseline digests.

## Final review and delivery record

The independent release correctness and source-custody reviewer returned GO on
the actual working-tree implementation over documentation HEAD
`b72bb4945968461e365b72adbe25f1472e1cdadd`, independently matching source-tree
digest `214b4a809815be2f8339e53fadc9c7dd98dd06590d4d747418af58bd7eb061bb`.
The reviewer ran all 25 kernel, conformance and actual-engine Host tests with
normal Node isolation, verified the one initial API anchor and all 13 unchanged
historical baseline hashes, and found no material defect. Two suspected
counterexamples were rejected by retained policy or Changesets itself.

That review predates the one-line suppression-governance admission correction
above. Confirmation against the eventual exact implementation commit and its
intervening delta remains required. The documentation HEAD alone does not
contain the implementation and is not a reviewed implementation commit.

Required final-head CI, owner PR, publication and three separate real consumer
adoptions will be recorded here as they are observed. The existing canary's
fresh complete owner-PR chain remains a distinct P6 requirement.

## Upstream release reconciliation

After the original pre-PR source gates passed, protected main advanced to
`4ca4ad30b1efc5e3b43a2c012348ea8afea21864`. This existing owner release consumed
seven prior intents, advanced seven package versions and promoted their owned
API baselines. It changes no implementation source or compiler dependency graph.
The implementation branch incorporates that revision without rewriting the
six plan-review commits. All upstream manifest, changelog and historical API
baseline bytes remain authoritative; only the new package's initial anchor is
additional. The initial API record above retains its original historical input
hashes and is not relabeled as evidence for these later baseline versions.

Final required source gates, independent commit confirmation and hosted CI
must qualify the reconciled head against the updated protected base.
