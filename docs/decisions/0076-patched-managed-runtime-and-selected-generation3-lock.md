---
id: ADR-0076
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0076: Patched Managed Runtime and Selected Generation3 Lock

Decision owner: Product owner. The owner renewed the existing Extension
Foundation end-to-end delivery, including necessary upstream corrections,
publication, qualification and normal merges. The repository architecture
coordinator records this bounded successor after two independent design-review
rounds covering runtime/recovery and delivery/source authority, and a real
canonical-lock materialization experiment.

Date: 2026-11-27. Implementation, independent source review, native qualification,
publication and consumer adoption remain distinct required evidence.

## Context and scope

The published retained controller admits physical 24.21.0/26.11.1 only, while
Extension Foundation has selected patched 24.22.3/26.12.1. Normal target staging
also produces a consumer-specific optional-peer/transitive graph that differs
from the independently qualified isolated managed closure. Both refusals are
correct under the existing exact contracts.

The [delivery plan](../research/managed-patched-runtime-target-lock-2026-11-27.md)
records the source revisions, alternatives, estimates and required observations.
Its disposable experiment admitted the canonical 88-package managed graph next
to EF's 407 foreign-reachable snapshots, preserved root types and every foreign
package, and completed an offline frozen pnpm 11.20.0 installation and peer
check without changing lock bytes. This proves that selected-lock preparation
is viable; it does not qualify forward mutation, recovery or publication.

Amend the current-policy/runtime coordinates of ADR-0059 and the bounded
retained transition of ADR-0070/0075 only. Existing accepted ADR bytes remain
immutable; their other requirements remain in force. Docs Protocol Agent Teams
owns consumer integration; Repository Mutation remains its writer; Central
owns published cohort/source/lifecycle authority; EF owns its Host integration.

## Decision

1. Publish current semantic policy 3.1.0 with physical retained controller
   Node 24.22.3 and target Node 26.12.1 on Linux/x64, and exact target pnpm 11.20.0.
   Use managed ranges >=24.22.3 <25 and >=26.12.1 <27 so projection preserves
   the selected security floor. Update the repository's private Node builder
   and native compatibility test pins coherently. Preserve the independently
   qualified historical managed-runtime custody checkpoint and its old tuple.
2. Retain structural current-policy 3 / profile 4 / Cohort 3 / managed-state 3 /
   qualification-receipt 1. Publish the semantic policy 3.1.0 schema at
   `architecture/contracts/docs-protocol-current-policy/v3.1.schema.json`, with
   `$id` `https://agent-teams.ai/schemas/docs-protocol-current-policy/v3.1` and
   structural `schemaVersion: 3`. Preserve the exact historical
   `architecture/contracts/docs-protocol-current-policy/v3.schema.json` bytes
   and its `/v3` identifier owned by ADR-0059. Admit the other exact scoped
   literal-policy/runtime changes to current artifact-protected schemas and
   public types through a new pre-1.0 minor release and exact observed
   fingerprints bound to this decision.
   This is not a general permission to mutate versioned schemas or an assertion
   of schema-family support. Historical policy 1/2, package archives, receipts,
   cohort records and release-owned baselines remain unchanged by this PR.
3. Keep physical controller selection separate from the captured source pin.
   Under the explicit retained 2-to-3 prepare route, admit existing legacy 24.x
   source images and the exact 26.11.1/26.12.1 Node 26 images, with stable canonical
   regular-file observation, immutable Git blob/mode and clean source identity.
   No arbitrary Node patch, platform, architecture, runtime override or broad
   legacy reader relaxation is introduced.
4. If source and target pin images agree, retain the pin as a read guard with
   no mutation or write ownership. If they differ, retain its ordinary owned
   CAS operation. Admission checks the original image; post-publication resume
   checks the recorded target image. Compensation and original/committed
   restoration retain exact original bytes/mode and authentic receipt custody.
5. Extend existing explicitly selected target-lock preparation from 1-to-2 to
   the additional closed 2-to-3 pair. Require prepare, source and target
   generations, restoration proof, one external stable regular file and its
   exact SHA256. Carry captured bytes through existing ports, sandbox,
   frozen installation, post-install/apply comparisons and preparation capture.
   Unsupported pairs and ordinary non-preparation operations continue to refuse.
6. Reuse the existing managed restoration lock scope validator for profile 3-to-4.
   Independently require the qualified target managed closure and byte/semantic
   preservation of foreign importers, dependency graphs, policy and comments.
   A lock producer grants no authority. A conflicting foreign-reachable target
   snapshot refuses. Introduce no generic lock resolver, second package manager
   or mutation engine.
7. Preserve exact controller/kernel build binding, source/target ancestry,
   authority refresh, phase-specific CAS, cold resume, authentic compensation,
   lost-receipt behavior, and offline frozen restoration. The retained source
   verifier must never initialize old consumer Foundation or TypeScript below
   7.0.2. Missing offline material or a sticky compiler denial is failed
   restoration, even if inverse file publication already occurred.

## Qualification and delivery

Run both different-pin 26.11.1-to-26.12.1 and same-pin 26.12.1 paths positively
under actual controller 24.22.3, including cold resume, receipt-owned
compensation and original/committed restoration. Retain wrong-runtime,
unsupported-pair, source/target/authority/build drift, pin byte/mode changes,
selected-lock tamper, wrong closure and foreign graph rejection controls.
Use the existing strict TypeScript projects, complete inventories, native
qualification and coverage authority. Wrong-runtime early returns are not
positive recovery evidence.

Use ordinary Changesets intent and the protected release-owned promoter;
never edit generated release baselines or release branch content by hand.
Require independent exact-head review, complete final-head/current-base full
native CI, normal owner merge and actual-main checks for source and release.
Verify actual immutable registry archives, signatures and provenance before
consumer use. No source fixture grants cohort qualification or enrollment.

Central must admit explicit correlated old 3.0.0 and new 3.1.0 tuples through
its current reviewed source-successor procedure before separate append-only
cohort/evidence registration. Desired selection, observed consumer adoption and
CANARY remain separate, genuinely observed steps. Preserve another proposal's
exact source authority and all historical lifecycle records. Qualify EF through
its actual Docs caller and the Central trusted qualification job; a producer
identity-bound canary cannot stand in for EF.

Before EF merge, qualify the published-controller transition and cold/original/
committed restoration in disposable copies, then repeat relevant recovery
against the final Host integration shape. Keep all EF changes in PR 70.
This decision authorizes no rollout to another consumer, stable runtime SPI,
browser loader, hostile-code sandbox or production Host claim.
