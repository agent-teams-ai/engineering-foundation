# Release candidate checks plan review

Status: all six requested sequential rounds completed on 2026-10-20. All
material findings were addressed before the next round. Implementation may
begin under the accepted delivery plan; implementation review and runtime
qualification remain separate.

The owner requested three sequential improvement rounds followed by three
independent critical-review rounds before implementation. This record concerns
the [current delivery plan](../development/release-checks-delivery-plan.md).
Earlier research and its eight critics are inputs, not substitutes for these
six requested rounds or final implementation review.

## Read-only preflight

Current Foundation source is `bbaf422dae36f0aa3ed9234a197aef076c64c63e`;
Get Modular is `ddf1e0b0053f546f12ca70190b237b4f7e78d09d`; node-or-bun is
`3e6a1c44195680761787e4377fc560dd0f22e223`.

Three independent technical preflights established the following:

- **Contract and reuse:** existing manifest equality is transferable; exact
  frozen-plan/candidate consistency is a new common guarantee. Whole-tree
  observation, content restrictions and binding must remain in the contract.
- **Foundation admission:** the independent pure leaf fits existing admission;
  every current catalog/ownership/typecheck/coverage projection must include it.
  The frozen historical eight-package migration packet remains unchanged. Public
  admission intentionally blocks ordinary publication until existing bootstrap.
- **Consumer integration:** a neutral independent leaf is not a Foundation
  dependency for node-or-bun. Its published root metadata needs a truthful patch.
  Get Modular still needs the narrow retained-input successor even when its
  pending real Resources patch is released, because four packages retain bytes.

These were source reads, not executed engine, CI, registry or E2E evidence.

## Requested review sequence

| Round | Scope | Reviewed plan identity | Outcome and disposition |
| --- | --- | --- | --- |
| I1 | Contract, Clean Architecture and semantic reuse | `80fcc900f0f0844aac1ee07647515556828a00e3` | CHANGE; I1-01 through I1-03 addressed in draft 2 |
| I2 | Admission, sequencing and operational recovery | `8a34565` | CHANGE; I2-01 through I2-04 addressed in draft 3 |
| I3 | Minimal consumer integration and acceptance scope | `a4f835967e33020a7ef8e98b4bf4966350cc6f4f` | GO; no material findings, proceed to C1 |
| C1 | Independent correctness and counterexamples | `d6d1240acca66126e9d9aed64a58e0015395d55e` | CHANGES; C1-01 through C1-03 addressed in draft 4 |
| C2 | Independent operational/consumer criticism | `d3dd0b129c5d2c6c709078bbce8e877ca0b72b41` | GO; no material findings, proceed to C3 |
| C3 | Independent final scope and consistency review | `c3428e32d1d4cc478f419ac035fb8ddc44c9fa13` | GO; no material findings, proceed to implementation |

Each round reads the actual revised plan, reports concrete findings and their
required disposition, and finishes before the next round begins. Record the
reviewed content digest and subsequent change, including a supported no-change
verdict. No fabricated reviewer receipt or unobserved execution is evidence.

## I1 — contract and semantic reuse

Reviewed plan SHA-256:
`bcaf77d0d8d7c06800eef5b11078e2927bd2d386ad6f544b840e51fccf06c1ed`.
Independent role: contract and architecture reviewer. Verdict: CHANGE.

| Finding | Disposition in draft 2 |
| --- | --- |
| I1-01: donor equality also protects native API pre-mutation and later PR attestation; the outer generation call alone is insufficient | Named every affected production seam, preserved checks before baseline mutation and on actual PR head/base, prohibited synthetic expected facts and duplicate equality, retained per-seam negatives |
| I1-02: equal supplied digests or twice-read historical source do not bind actual execution; a second collector risks divergent plan authority | Bound actual root/Git/processed commit/CLI/config and their re-observation; admitted the action's legitimate branch reset; reused the existing official-plan collector and added actual execution-drift negatives |
| I1-03: complete plan records and actual version-edit set differ for v3 none/private/ignored records | Preserved complete records and explicit absence, compared only required edits, made consumption expectation explicit and added a mixed unchanged/real-release fixture |

No new package, CLI, facade, DI layer, generic inventory utility or rewrite API
was required. Implementation remains pending I2-I3 and C1-C3.

## I2 — admission and operational continuation

Reviewed plan SHA-256:
`bbea1eb636ae46b72e3b2862c2cbe722a2dec243ffc278ab43d6551ae06aee9e`.
Independent role: admission and release operations reviewer. Verdict: CHANGE.

| Finding | Disposition in draft 3 |
| --- | --- |
| I2-01: npm maintainer interaction is not established by GitHub readiness or local npm authentication failure | Made the existing pre-admission gate concrete; prepare all reviewable work but keep admission unmerged if the required account interaction is unavailable; create no early timed token |
| I2-02: bootstrap completion does not trigger the push-only release workflow | Recorded exact-main CI, timed bootstrap, postconditions, Trusted Publisher/cleanup, current-input rerun or newer-main generation, owner PR and supported-release/historical continuation |
| I2-03: an unnamed fresh TEST target obscures the missing owner PR chain | Selected the existing canary repository/namespace, separated its prior publisher proof from the required extension, and bounded its unprotected-main evidence |
| I2-04: pre-bootstrap public registry installation would be impossible | Named P1's existing hermetic Verdaccio qualification and P3's separate exact public npm proof |

Read-only P0 execution also qualified 14 disposable engine cases against the
actual installed Changesets 2.31.1 and 3.0.2. The retained
[qualification report](evidence/release-checks/p0-engine-qualification.json)
records original source, engine identities, plans and version/consumption
effects. Its digest is
`50daf5e0f8fc0eb7c9b8db4da6caa60bfb319e2eecd8bf217c318a0c8459c1bb`.
The fixture formatter uses the bundled local changelog writer to avoid remote
GitHub I/O; this is plan/manifest/consumption proof, not production changelog,
lock, CI or publication proof. No real source was versioned.

Both engines preserve the qualified symbolic Get Modular workspace ranges but
generate different dependent versions on part of the same graph. Foundation's
in-range FMS peer case changes no peer range; an out-of-range major rewrite is
outside the version-only contract and must reject. `none` records can also
occur in v2. Ignored/private intents can appear in official plan input while
remaining unconsumed. Explicitly running version consumes empty intents, so
the no-release Host must avoid that call. A real mixed release may consume
empty housekeeping intents while retaining ignored/non-versioned private
intents. These observations refine adapter expectations without introducing a
second version or dependency-propagation engine.

## I3 — minimal consumer integration and acceptance scope

Reviewed plan SHA-256:
`e540a0dcf3556e84e69ed2f50547c89163bbac3ef85a9e346c439ca5c3431347`.
Independent role: consumer architecture and acceptance reviewer. Verdict: GO.
No material findings or plan changes were required. The reviewer verified the
bounded pure contract, actual engine fixture scope, Get Modular retained-input
successor requirement, node-or-bun truthful metadata release and existing TEST
owner-PR extension. The canary's unprotected-main limitation and separate
three-repository evidence remain explicit.

Review limitation: historical Get Modular blob retrieval failed through the
reviewer's configured network proxy. Current policy, retained tree identities
and documentation were read; this round does not certify future retained-input
isolation or historical manifest bytes. P4 retains that implementation gate.

The required improvement sequence is complete. Implementation remains pending
the three sequential critical-review rounds C1-C3.

## C1 — independent correctness and counterexamples

Reviewed plan SHA-256:
`e540a0dcf3556e84e69ed2f50547c89163bbac3ef85a9e346c439ca5c3431347`.
Independent role: release consistency and counterexample reviewer.
Verdict: CHANGES. All three findings were medium severity plan clarifications.

| Finding | Disposition in draft 4 |
| --- | --- |
| C1-01: visibility alone cannot define reciprocal intended-package coverage | Separated Host-qualified version eligibility and pending/retained intent participation; required corresponding direct plan links for every eligible pending request; preserved existing prerelease metadata consumption |
| C1-02: equal physical paths across distinct checkouts would reject legitimate PR qualification, while ignoring them would lose execution custody | Separated portable source/engine/content binding from per-execution root/Git/working-directory/installation custody and retained substitution negatives |
| C1-03: Changesets alone leaves npm root lock versions stale | Added explicit lock-only npm synchronization after engine versioning and before complete candidate observation; retained metadata-only comparison and graph-drift rejection |

The additional actual npm canary probe is retained in
[its P0 report](evidence/release-checks/p0-canary-engine-qualification.json),
SHA-256 `dff1fc07f65a4444087127cb16f7781ada50af3c1e6fafa71a3bc14ce54fbc88`.
It qualifies isolated Changesets 3.0.2 single-package generation and lock-only
normalization, not the future shared checker, owner PR, hosted action or new
publication. The real TEST checkout remains unchanged by that probe.

The reviewer found no further changes necessary for whole-tree observation,
manifest content restrictions, pre-baseline/current-PR placement, honest DRY
scope, v2/v3 unchanged records, or the existing provider-readiness boundary.
Implementation remains pending C2-C3.

## C2 — independent release operations and consumers

Reviewed plan SHA-256:
`ddaed322c6d2409ad7b283c16e72824df9eb7a1e7c5ca00615a87d6f5d1e9b82`.
Independent role: release operations and consumer reviewer. Verdict: GO.
No material findings or plan changes were required.

The reviewer checked the actual push-only release/bootstrap continuation,
exact-main CI and timed credential ordering, coherent admission recovery,
Get Modular's current and retained build-input policies, node-or-bun's metadata
release precedent and corrected npm lock order, and the TEST target's actual
missing owner-PR extension. The retained Get Modular root manifest at
`2cd561688bb223f944425718cc093e55ff4bc20d` was now locally readable; no retained
archive isolation claim was inferred merely from that read.

This read-only GO admits the plan to C3. It does not establish implementation,
new CI, publication or provider readiness. Public admission remains unmerged
until the existing interactive npm route is available.

## C3 — final scope, coherence and minimality

Reviewed plan SHA-256:
`ddaed322c6d2409ad7b283c16e72824df9eb7a1e7c5ca00615a87d6f5d1e9b82`.
Independent role: final scope, coherence and minimality reviewer. Verdict: GO.
No material findings or behavioral plan changes were required.

The reviewer confirmed the single engine, bounded pure public operation,
complete observation and version-only relation, honest donor removal across
all production seams, corrected intent/physical-custody/npm-lock semantics,
existing admission/bootstrap recovery, both consumer boundaries and separate
fresh TEST/real-repository acceptance. No further planning round or additional
approval procedure was requested. The plan status now permits implementation.

The reviewer used the explicit local organization standard and byte-identical
retained standard after its own live retrieval hit the unavailable proxy;
standard SHA-256 was
`a65fb5150837b010a71abe36cefd26c32709eb9b9e89f3938498a647e72f5587`,
retained canonical revision `f5653f5630057524a4ee44e50c16e138442a9b42`.
This is a read-only plan review, not hosted execution or publication proof.

All six requested reviewers used the owner's selected GPT-6.1-sol/xhigh model
setting. The sequence was I1 CHANGE (3), I2 CHANGE (4), I3 GO, C1 CHANGES (3),
C2 GO, C3 GO. Each subsequent reviewer read the actual persisted revision and
dispositions. The plan's remaining npm readiness prerequisite controls public
admission merge; it does not block authorized source and review preparation.
