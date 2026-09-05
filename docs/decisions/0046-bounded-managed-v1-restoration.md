---
id: ADR-0046
status: proposed
supersedes: []
superseded_by: []
---

# ADR-0046: Bounded Managed V1 Restoration

Status: Implementation decision submitted for independent integration review

Date: 2026-09-05

Decision owner: Product owner

## Context and authorization

The original managed migration acceptance includes positive post-success
restoration to V1. ADR-0045 makes deliberate V1-to-V2 migration reversible from
immutable recorded evidence. ADR-0043 cancels compatibility routing; it does
not cancel restoration. ADR-0034 requires a separate lifecycle decision and
source/target package-and-lock evidence before a rollback edge is executable.
This record closes that implementation gap without changing central policy.
Qualification of published artifacts and actual central admission remain
separate obligations. This patch does not manufacture a qualified edge.

## Decision

Docs Protocol Agent Teams owns one explicit, opt-in restoration of the same
consumer following a successfully activated generation-1-to-generation-2
migration. It uses Repository Mutation's public Plan parser/compiler, barrier,
CAS apply, receipt and recovery interfaces. The generic kernel remains unchanged.
The controller and its exact kernel installation must be retained outside the
consumer and the installation that will be replaced. No bridge, old export,
portable dependency on managed behavior, plugin or runtime discovery is added.

Before publication, a requested proof destination receives an exclusive,
bounded `.prepared` companion containing consumer identity, source revision and
tree, full repository inventory digest, immutable Cohorts, original full Plan,
and controller/kernel name, version and build identity. This companion is inert
preparation evidence; it cannot authorize restoration. Only after successful
managed activation and exact postimage reobservation is the final proof written
exclusively and synced. It additionally binds the exact full receipt and verified
V2 activation. Partial, pre-existing or ambiguous files are preserved and fail.
These are two immutable evidence records, not another mutable transaction journal.

The operator retains the returned successful-upgrade proof digest separately.
The proof file is untrusted input; its own contents or a recomputed digest do not
provide that selection authority. Restore requires the separately retained
`--expect` value, strict duplicate-free canonical JSON and exact closed shapes,
public Plan validation and reconstruction of the entire receipt. Missing,
unknown, mixed, noncanonical and tampered evidence fails closed. A digest is an
integrity binding to an authenticated successful invocation, not a signature or
protection against an operator who deliberately fabricates both file and digest.

The source Git object binds every original preimage. Only the original complete
managed replacement set can be inverted: integration profile, manifest, lock,
managed state, Skill, caller workflow, AGENTS route and an already-existing
workspace file. No new file, broad tree restore or accepted-preimage alternatives
are supported. Modes are preserved exactly. A complete repository inventory,
including ignored files except installation/kernel state, rejects unrelated
changes. Repository identity, canonical root and filesystem identity prevent
transplantation. Git replacement objects are disabled for source observations.
The manifest's real `packageManager` pin is preserved.

Fresh protected central main must bind the exact recorded current V2 Cohort,
its explicit `rollback_to` and `upgrade_from` origin, and the original qualified
V1 projection. The adapter mirrors existing central binding support: RECOMMENDED,
enrolled QUALIFIED/CANARY, or SUPERSEDED before `support_until`. A suspended
source may leave by its recorded edge; a suspended or unsupported target may
not be restored. Supported SUPERSEDED selection is confined to recorded
restoration bindings and does not expand ordinary upgrade eligibility. Consumer
repository ID and name must match explicit GitHub execution identity. Central
schemas, decisions, guards, protection and enrollment remain unchanged.

The inverse holds the existing operation lease during current-state and fresh
authority validation and obtains a kernel claim for exactly that inverse Plan.
Activation runs after kernel publication/cleanup, because the historical CLI
requires an idle barrier. Historical installation uses actual Corepack with
`pnpm install --offline --frozen-lockfile --ignore-scripts --ignore-pnpmfile
--verify-store-integrity`, followed by the explicit installed historical
`docs-protocol/dist/cli.js consumer check`. Corepack network access is disabled
for offline installs, and a nonzero CLI exit cannot claim success. Success also
requires exact files and
modes after activation. Local actors remain subject to the existing cooperative
writer threat model; the adapter does not claim protection against arbitrary
concurrent malicious OS-level writers.

## Concrete runbook

Retain the exact controller installation and record its package/build identities.
Use its absolute CLI path for every command below. Keep the approved explicit
pnpm store available, populated by the forward staging install and the original
V1 installation. Do not change HOME, replace Corepack, enable scripts/hooks or
substitute a floating package manager. Set the real `GITHUB_REPOSITORY_ID` and
`GITHUB_REPOSITORY` execution identity. The consumer must be a disposable TEST
repository during qualification.

```sh
node /retained/controller/dist/cli.js upgrade --consumer /TEST/consumer \
  --source-generation 1 --target-generation 2 --to QUALIFIED_V2 \
  --restoration-proof /retained/evidence/migration.json --json
```

Retain the successful result's `restoration.digest` in independently controlled
evidence. The preparation companion and final proof must stay outside both
consumer and controller trees. Keep the original Git objects available. Restore
only the original target; do not substitute another old Cohort or edit the proof.

```sh
node /retained/controller/dist/cli.js restore --consumer /TEST/consumer \
  --source-generation 2 --target-generation 1 --from QUALIFIED_V2 --to ORIGINAL_V1 \
  --proof /retained/evidence/migration.json --expect sha256:RETAINED_DIGEST --json
```

Before inverse publication, refusal leaves foreign changes intact. Preserve all
evidence and resolve the concrete conflict outside this command. A killed
APPLYING transaction requires the retained controller's `recover --consumer
/TEST/consumer --json`; exact kernel identity is the journal owner and kernel.
Recovery restores V2 bytes, after which the same explicit restore can be retried.
A COMMITTED inverse means cleanup only and leaves V1 bytes. Never rewrite journal
state or relabel COMMITTED as undo. After cleanup, or if installation/check fails
after inverse publication, run the same restore command with `--activation-only`.
That route requires an idle transaction and the entire exact V1 tree, performs no
inverse publication, and returns `activated-v1` only after historical installation
and check pass. Normal restore rejects already-restored/stale postimages.

A failure between successful V2 activation and final-proof persistence emits no
successful result. Preserve `.prepared`, any partial proof, kernel evidence and
the controller installation for independent diagnosis. Neither preparation nor
COMMITTED proves successful managed activation, and this route cannot upgrade
those records into a successful proof. Do not synthesize the missing digest.
Existing migrations without retained successful proof are not retroactively
eligible. No Git reset or replacement checkout is positive restoration evidence.

## Qualification obligations and limits

The focused same-fixture test must observe V1 bytes/modes and old CLI, complete
V2 activation, use supported restoration, then prove exact identity and old
installed behavior. It must reject hostile proof/identity/build/edge/support,
foreign edits, path/mode/symlink attacks and active transactions. Actual kernel
APPLYING and COMMITTED process-death boundaries, activation failure and explicit
activation retry must be observed. Existing upgrades and exact-build recovery
remain separate regression requirements.

Hermetic package fixtures and injected authority establish implementation
behavior only. Published source/target package SRI, provenance, immutable
qualification, fresh protected consumer binding and actual old released CLI
must be qualified by the release owner after the corrected protected release.
The proof is bounded to 24 MiB and eight existing replacements, within the
kernel's own stricter image/Plan limits. Oversized repositories or evidence fail
before mutation. The existing forward Git archive preparation requires source
modes reproducible by Git (0644/0755); other modes are refused before migration.
Windows remains explicitly unsupported for durable known-file
publication; Linux evidence is not Windows or macOS qualification.

## Rejected alternatives

- Scan arbitrary retired COMMITTED snapshots as evidence of successful activation.
- Infer generations, fabricate symmetric edges or admit every historical Cohort.
- Reinterpret generic recover as rollback, or introduce another journal engine.
- Use source revision alone to rewrite unrelated files or recreate a fresh checkout.
- Promise success after file inversion when the historical executable still fails.
