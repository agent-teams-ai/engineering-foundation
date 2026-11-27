# Patched runtime and selected lock for the retained managed transition

Date: 2026-11-27. Status: implementation after two independent design-review
rounds and a real frozen-install experiment; release and adoption remain pending.

Producer base: 8432a9737486384f894436bfd9242500e422fa5a.
Consumer: Extension Foundation PR 70 at
8c16e5dbf24d8a09d9f33fe7c3ee8f38bf74599c.
Initial Central base: 89b5d7c512d9c4b5ae63709857a0d71cb2e6d178;
Central PR 441 subsequently merged as 9d8aa752886c00d5b3d9154e0b6c00e65a4e33cc.
Re-observe current source authority and protection before proposal and merge.

## Assigned outcome and demonstrated failures

The owner renewed the existing EF end-to-end goal, including necessary
prerequisite fixes, reviews, pull requests, publication, normal merges and
successful actual-main checks. Continue the existing
[preserved Node 26 plan](managed-node26-source-upgrade-2026-11-26.md).
All EF changes remain in PR 70; prerequisites remain in their owning repositories.
Do not weaken gates, fabricate evidence or alter another agent's worktree.

EF's new package qualification, package admission and documentation checks pass.
Its old Foundation embeds unsupported TypeScript and must not execute.
Published adapter 0.7.1 refuses the physical Node 24.22.3/26.12.1 tuple and
preserved source pin. An earlier real attempt with its admitted old tuple reached
a separate closure refusal: ordinary preparation inherited EF's root Node-types
optional-peer context and older transitives. Central independently rebuilds the
canonical isolated three-root closure; registering the failed digest is no fix.

## Selected coherent implementation

[ADR-0076](../decisions/0076-patched-managed-runtime-and-selected-generation3-lock.md)
records the bounded current-policy 3.1.0 successor. Retain profile 4 / Cohort 3 /
state 3 / receipt 1 structural coordinates, physical controller 24.22.3, target
26.12.1 and target pnpm 11.20.0 on Linux/x64. Generated managed ranges preserve
the security floors >=24.22.3 <25 and >=26.12.1 <27. Generate packed policy and
its exact schema with the existing generator. Public literal/schema changes
require actual observed ADR-bound fingerprints and ordinary release promotion.

Physical controller selection is separate from source pin bytes. Preserve
historical source pins and admit only the additional exact26.12.1 image through
the retained source reader. The captured file, Git blob and mode must agree.
Source26.11.1 to target26.12.1 owns a normal pin CAS operation; same-pin26.12.1
is a read guard with no write ownership. Post-publication resume observes the
appropriate target image. Do not apply an original-image guard to a legitimately
changed pin. Preserve exact-build, authority, ancestry, receipt and offline
restoration boundaries, and the deny-only compiler guard.

Extend the existing explicitly selected target-lock option only to prepare
source-generation2 / target-generation3 with restoration proof and input hash;
retain its1-to2 route and all other pair refusals. Capture stable external bytes
once, clone them in preparation, validate exact target closure plus the existing
managed restoration lock scope, frozen-install, and check post-install/apply and
captured operation bytes. No new graph resolver, receipt family or writer.

Candidate construction is outside the live consumer: replace only managed graph
entries not reachable from foreign roots, using collected canonical target
snapshots. Preserve all foreign importers, graphs, comments and policy. The
historical restoration evaluator is a fixed qualifier, not a generic generator.
Input construction grants no authority; strict independent validators decide.

## Bounded experiment

The exact EF source lock was
sha256:abc88528117429ac3f5e84c57e7475965f0222ad848da689b65d0b72fb2465fb.
The canonical stable33 managed closure was independently pinned as
sha256:aa79cc15300790ba1f76413a93b60c0a0c51d2854e7c90b0195bba0d12198bbf.
Source482 snapshots contained84 managed and407 foreign-reachable snapshots,
including9 shared ones. Replacing the owned graph with88 canonical target
snapshots produced470 snapshots without any foreign snapshot/package collision.
Root Node types24.13.3 and every foreign entry remained.

The existing strict closure and managed scope validators passed before and after
a real Node26.12.1 / pnpm11.20.0 offline frozen installation. Lifecycle scripts
and pnpm hooks were disabled, engines/peers strict. Installation and the separate
lock-only peer check exited0. Exact selected lock bytes remained
sha256:2393d9bb7d8072482dc069c343172c93c51ff07ef87d21b6f2f34082d05e415f.
No old Foundation CLI or compiler below7.0.2 executed.
An earlier unbounded installer was killed137; a bounded one-worker retry passed.
This is real materialization evidence, not controller recovery or adoption.

## Alternatives and estimates

Only two technically credible closure routes remain. Moving EF's legitimate
root types or rewriting unrelated dependencies solely to fit tooling would
change consumer architecture without solving the owner's intended mechanism.

| Route | Production/integration LOC | Tests/fixtures LOC | Engineer-days | U | N | C |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Extend existing selected-lock2-to3 route | 100–230 | 220–500 | 2–4 | 9 | 8 | 4 |
| Trusted consumer-seeded closure qualification in producer and Central | 450–900 | 650–1,200 | 5–9 | 6 | 8 | 8 |

U is fitness, N expected reliability in the bounded cooperative Linux/x64 scope,
and C maintenance burden. These are ordinal judgments, not availability claims.
Estimate confidence is5/10. Runtime changes add approximately180–400 integration
and350–800 test lines; bounded Central tuple support adds120–260 integration and
180–450 test lines. Exclude generated artifacts, locks, prose, native CI,
signed release and elapsed provider/runner time; ranges are incremental.

The selected route's strongest counterexample was manager repair of canonical
optional-peer snapshots even in frozen mode. The actual experiment rejected
that concern for this EF specimen. Fresh published-target qualification remains
necessary; do not carry the old closure digest into a new package tuple.

## Acceptance

1. Observe actual selected runtimes, pnpm, platform, architecture and policy;
   invalid initial coordinates refuse before installation/publication.
2. Execute changed-pin and same-pin preparation, cold finalize/resume,
   compensation and original/committed restoration under actual24.22.3.
   Wrong-runtime early returns do not count as positive cases.
3. Execute target-lock2-to3, exact captured-byte and independent closure checks;
   reject unsupported pairs, ambiguous/tampered external input, foreign graph
   changes and installation/apply/capture drift.
4. Preserve lost-receipt honesty, fresh authority/ancestry/build checks,
   offline restoration and sticky compiler-denial negative controls.
5. Retain complete strict typecheck, source ownership, test inventories and
   coverage. Focused local checks precede independent exact-head review and
   the complete final-head/current-base native full-ci matrix.

## Delivery sequence

1. Complete source changes with normal Changesets intent; generate assets and
   accepted-decision metadata using their actual owner commands. Preserve
   release-owned baselines and automated release-branch ownership.
2. Run changed/fast/workflow checks, independent review and full native CI;
   merge source normally and observe actual-main checks.
3. Let ordinary protected-main Release regenerate the existing owner release
   PR, review its derived graph and provenance, qualify and merge normally,
   then wait for signed immutable publication and public-installation checks.
4. Deliver separate Central closed dual-policy support. Preserve historical
   3.0.0 and admit only correlated3.1.0/26.12.1 coordinates. A new typed runtime
   authority helper must remain inside a protected source closure after merge.
   Qualify the exact bounded source successor through the existing owner route;
   another PR's temporaryV7 tuple and an owner bypass cannot authorize this one.
5. Register actual published coordinates and closure in a separate append-only
   cohort/evidence PR and obtain real VERIFIED/QUALIFIED observations. Keep
   policy/schema/workflow changes out of that evidence proposal.
6. Qualify published-controller forward, cold recovery and original/committed
   restoration in disposable EF copies. Deliver a separate EF-only desired
   selection, preserving observed stable31 until real adoption. Coordinate the
   old desired-selection PR434 without changing another agent's branch.
7. Perform the managed transition and Host-owned tooling adaptation in EF70;
   repeat recovery against the final Host shape. Require complete current-head
   gates, independent review, normal merge and actual-main qualification through
   EF docs-protocol.yml and Central trusted-qualification.
8. Finish Central observed adoption and separate CANARY promotion using real
   merged EF evidence. Producer identity-bound canaries cannot substitute for
   EF; stable public SPI and production Host adoption remain outside this goal.

## Independent review and execution record

Runtime/recovery round1 identified the different-pin post-publication guard
hazard; incorporated. Delivery/source-authority round1 identified the temporary
CentralV7 exact-PR boundary; incorporated. The closure reviewer distinguished
historical evaluator from input construction and proved the real materialization
premise. Round2 accepted these corrections in each independent scope.

During preparation the local executor exhausted resources and restarted.
Published EF work and Central worktree remained; the temporary producer worktree
was lost. The producer patch was reconstructed from its exact immutable base and
the recorded owned edits and saved through GitHub. Reconstructed code requires
fresh source review and actual checks; previous static observations do not
qualify its new source. No release or adoption completion is asserted.
