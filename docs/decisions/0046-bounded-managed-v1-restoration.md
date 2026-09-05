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

The opt-in lifecycle separates preparation from consumer publication. `upgrade
--prepare --restoration-proof` runs normal disposable staging, then exclusively
writes and syncs an immutable `.prepared` companion. It binds consumer identity,
source Git revision/tree and inventory, exact original Plan/preimages, original
and target Cohorts, initial final destination, and the retained controller/kernel
names, versions and build identities. Its returned digest must be independently
selected **before** `finalize` can mutate the consumer.

`finalize --preparation --expect --proof` validates that exact selection, source
Git and managed effects, root/inode, exact artifacts, fresh central upgrade and
rollback authority, and the entire original or target inventory. Every attempt
uses public kernel apply, including retries against already-satisfied target
images. The result reports that attempt's honest receipt. After public cleanup,
actual target offline Corepack installation/check and exact inventory revalidation
must pass before the exclusive final proof is synced and its digest returned.
An original receipt is retained in a create-only `.receipt` companion whenever
public apply returns; a kill before its retention can leave no original receipt.
A retry records `already-satisfied` as observed, never invented replacements.
The proof's optional original receipt is historical retained evidence, while its
receipt records the completing attempt. They are not independent signatures.

Preparation never authorizes inverse or establishes successful activation.
Restore accepts only the independently observed **final** digest. A lost final
stdout requires explicit `finalize` retry, which performs public apply and real
target activation again, then returns the existing proof digest. An intact
preparation digest cannot authenticate a fabricated later completion. The retry's
current receipt remains separate from any receipt in an existing final proof.
Partial or colliding final files/companions are preserved; select a distinct
explicit `--proof` path to retry. The final proof binds that destination. Original
receipts at earlier destinations remain retained there; absence of replacement
history in a retry is explicit. These immutable records are not a second journal.

The operator retains the returned successful-upgrade proof digest separately.
The proof file is untrusted input; its own contents or a recomputed digest do not
provide that selection authority. Restore requires the separately retained
`--expect` value, strict duplicate-free canonical JSON and exact closed shapes,
public Plan validation and reconstruction of the entire receipt. Missing,
unknown, mixed, noncanonical and tampered evidence fails closed. A digest is an
integrity binding to an authenticated successful invocation, not a signature or
protection against an operator who deliberately fabricates both file and digest.

The source Git object binds every original preimage. Scope is checked independently
of candidate Plan/receipt hashes: existing deterministic forward projectors must
reproduce the exact changed-path set and permitted postimages. The profile,
manifest and workspace retain non-owned fields; AGENTS retains every byte outside
its managed route. Skill, caller workflow and generated state are whole-file
managed assets bound to exact source/target projections. The lock's independently
qualified managed closures may change, while other policy, importers, dependency
entries and shared/foreign package graphs must remain semantically identical.
Consumer lock comments must survive unchanged; staging that loses them is refused
before consumer mutation.
Canonical evidence may reorder object keys, so profile rendering accepts only
key order from an otherwise exactly equal target Cohort. The actual owned set is: integration profile, manifest, lock,
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
restoration bindings and does not expand ordinary upgrade eligibility. Caller
`GITHUB_REPOSITORY_ID` and `GITHUB_REPOSITORY` values are optional
assertions: each supplied value must match independently, with case-insensitive
repository-name comparison. These variables do not add authentication or replace
the exact consumer, Git, selection and central bindings. Central
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
substitute a floating package manager. Local callers may omit both GitHub identity
variables; each supplied value must agree with the consumer identity (repository
names compare case-insensitively). The consumer must be a disposable TEST
repository during qualification.

```sh
node /retained/controller/dist/cli.js upgrade --consumer /TEST/consumer \
  --source-generation 1 --target-generation 2 --to QUALIFIED_V2 \
  --restoration-proof /retained/evidence/migration.json --prepare --json
```

Retain the preparation result's `preparation.digest` independently before mutation.
Keep all evidence outside both consumer and controller trees, and keep original
Git objects and exact controller/kernel installations available. Apply/finalize:

```sh
node /retained/controller/dist/cli.js finalize --consumer /TEST/consumer \
  --source-generation 1 --target-generation 2 --from ORIGINAL_V1 --to QUALIFIED_V2 \
  --preparation /retained/evidence/migration.json.prepared \
  --expect sha256:PRESELECTED_INTENT --proof /retained/evidence/migration.json --json
```

Only after successful real target activation and final retention, retain the
result's `restoration.digest` independently. Restore only the recorded origin:

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

After a failed or killed forward finalization, preserve preparation, receipts,
partial final files and kernel evidence. APPLYING requires the retained exact
controller's `recover` first; recovery returns original V1 images. COMMITTED
cleanup leaves V2 images and proves no managed activation. After the kernel is
idle, repeat `finalize` with the original independently retained preparation
selection. Use a new explicit final path when an existing file/companion is
partial or colliding. The retry revalidates actual target installation/check;
it does not silently undo a committed migration. With complete proof but lost
stdout, repeat `finalize` at that exact path to obtain its digest after real
revalidation. Do not pass preparation selection to `restore`, including
`--activation-only`, or synthesize a completed proof/digest. Migrations without
preselected evidence cannot acquire this route retroactively.

## Qualification obligations and limits

The focused same-fixture test must observe V1 bytes/modes and old CLI, complete
V2 activation, use supported restoration, then prove exact identity and old
installed behavior. It must reject hostile proof/identity/build/edge/support,
foreign edits, path/mode/symlink attacks and active transactions. Actual kernel
APPLYING and COMMITTED process-death boundaries, activation failure and explicit
activation retry must be observed. Forward final-write EFBIG/EACCES, partial and
colliding files, SIGKILL between CAS and proof retention, lost stdout, intact-intent
fabricated completion, failed target check and selected retry require actual CLI
serialization evidence. Existing upgrades and exact-build recovery
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
