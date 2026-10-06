# Private managed runtime observation and disposable installation (P2a/P2b)

Status: unselected, feature-private source checkpoint under proposed
[ADR-0056](../decisions/0056-bounded-qualified-managed-node-26-transition.md).
Node 24 remains production/default. Existing stable Cohorts and historical
upgrade/restoration contracts retain their bytes and behavior.

`docs-protocol-agent-teams/consumer-integration` owns the application observation
port and pure supplied-tuple comparison. Its Node adapters own physical identity,
child execution and cleanup. `composition/managed-runtime.ts` is a typed factory
with explicit Host inputs. Construction performs no IO or runtime selection.
The scope exposes `admit`, `observe`, `acquireAttempt`, `ownedInstallationRoot`,
`install`, and `close`; package/application API exports and managed CLI routes
do not expose this seam. P2b adds source-private contracts and inward transition,
release-fact and disposable-project policy. Composition remains an inert typed factory.

Host supplies an absolute provisioned Node executable, a complete physical pnpm
package root, independently trusted pre-provisioning SHA-256 digests, a private
non-consumer workspace, and cancellation. Admission snapshots data descriptors,
creates one owned directory and issues a factory-local handle. Forged, foreign
or closed handles refuse. A runtime handle identifies its issuing scope;
installation also requires a separate factory-local owned-root handle and a live
exclusive attempt. Serialized or foreign handle copies convey no authority.

The supported TEST tuples are linux/x64 Node 24.21.0 or 26.10.0 with pnpm
11.20.0, launched by the absolute selected Node. Corepack and other platforms
refuse. Identity binds executable bytes and metadata, manifest/bin entry and the
whole pnpm tree. Aliases, tree links, hardlinked/special files, oversized inputs,
malformed manifest/bin selection and byte or physical identity changes refuse.

Process and fixed probe sources must remain paired. The process adapter's
`PROBE_SHA256` must equal the SHA-256 of the rebuilt fixed probe; any probe
argv change requires regenerating that exact pin before execution.
Private fd 3 reports the child's identity; fd 4 blocks execution until Linux
`/proc/<pid>/exe`, process-start identity and selected bytes agree. Actual pnpm
then runs `--version` in that same Node process. Exact stdout and the final
runtime-image recheck must agree before returning an observation.

The child probe has a 30-second timer, 8 KiB handshake, 1 MiB combined output
limit, bounded diagnostic tail, strict streaming UTF-8 on both output streams,
scrubbed environment and cancellation. Success requires direct-child reaping,
observed empty cooperative POSIX group and closed streams. Close cancels and
waits for active work; concurrent/repeated close shares a result. Unknown child,
group or stream liveness retains debt. Directory and parent identities fence
owned cleanup; substitution or denied cleanup retains debt and foreign data.
Filesystem work has no total time bound; a PID alone grants no group authority.

## Shared invariants and current guidance

Foundation's accepted local FMS v1 profile remains the governing adoption:
SHA-256 `851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa`.
Repository Mutation's public `/serialization` owns strict JSON; identity and
process callers have exact primitive admissions in the existing feature profile.
Portable Docs Protocol retains portable application/qualification ownership.
Host owns concrete provisioning, processes, effects and resource lifetime.
There is no demonstrated second conforming consumer for a generic process
service, so extraction is not admitted by the extraction admission invariant.

Historical supplied CMS consultation includes Get Modular revision
`9c722ceff4ede307d06d7a4b63fdebe615f54c53`, full-document SHA-256
`33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd`.
ADR-0056 separately records historical CMS 6b31f20/d555dfd4 with full-document
SHA-256 `d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f`;
R207 authenticates that historical evidence. Accepted ADR bytes and pins remain immutable.

The current supplied delta assessment identifies historical 9c722 to current 2ef.
It includes ADR-0030 resources and cooperative cleanup, ADR-0031 per-run scope
and declared inputs, ADR-0032 contract descriptors and authoring builder, and
ADR-0033 conformance changes. Current consultation is distinct from historical
adoption evidence; this checkpoint does not invent a new full-document digest
or claim CMS adoption. The earlier assertion that the delta contained only
ADR-0029 and optional dynamic lifecycle guidance is superseded by this assessment.

Fixed static helpers and typed factories remain within one cohesive feature,
with inward contracts and explicit outer Host composition. They are not Assembly
graph nodes. Foundation's existing feature-module profile governs their exact
admission. No resources, Core, Assembly, SPI, platform service or lifecycle-kernel
dependency is added. Cooperative resource cleanup and the dynamic lifecycle
candidate do not replace domain-specific physical custody, process attribution
or durable exclusion. Authority is rechecked after custody awaits; an observer
or process deadline does not itself release owned work. Runtime's retained
passive consumer pin and historical accepted evidence are not migrated here.
The supplied organization quality standard's complete bytes have SHA-256
`e97a2d9f5ec7d05f9a515c28df38fb921c5048d4e2cab850561717f7dedff5d7`.

## Evidence boundary and retained successor

P2a takes final repaired source from retained
`f8004c1717f44671ad3f170a0e2fe2f15973916a`, extraction parent
`2b120c80579e67a3da14bf71db8e9c8a8cf62e33`, onto actual merged main
`b8ec0f17d1b8d6f9b7a45798931715d59a126888`. The final scope's attempt/install
imports, APIs, handle map, state and close block are withheld together.
The fixed probe and inert private install-mode support remain paired; no install
API or operational stub is introduced. Required gates exposed inherited unregistered
lint suppressions: bounded manifest/probe-phase helpers and a private one-shot
process owner replace them, preserving final identity, cancellation and cleanup fixes.
The process owner uses the existing consumer clock and explicit Node promise timers;
owned timer cancellation releases waits when the child or operation settles.

P2b ports the retained attempt, attempt-close and pnpm engine/peer enforcement
suites and custody mechanisms onto supplied current source
`5f9ac44ee95bba0ea6a6f9975f24edd3d46fd6ec`. Current P2a observation, identity,
process and fixture hardening remain in place; old runtime/process/identity files
are not restored wholesale. These source changes are an implementation proposal,
not an executed installation or public managed Node 26 qualification.

Host must supply one common physical external exclusion namespace to every
contender for a physical consumer, including independent scopes and processes.
Within that namespace, the O_EXCL record key uses the consumer directory's
device and inode, so supported canonical spellings of the same physical directory
share exclusion. Symlink spellings refuse. Controller/start/boot and runtime
identities, serialized durable phases and an authenticated release sibling fence
custody. This private helper cannot prevent Host from configuring disjoint external
namespaces; enforcing the common namespace across all contenders remains a Host
responsibility for future actual central E2E. No global namespace registry is added.
Existing or uncertain records are never reclaimed automatically. A provisional
reservation permits debt-free refusal only after authenticated removal, successful
directory synchronization and descriptor close. Ownership, disposal, synchronization
or descriptor-close uncertainty retains debt through repeated scope close and
preserves substituted bytes. Issued close
reserves synchronously, cancels installation and waits for active work. Unknown
custody remains irreversible in that owner. A synced hard link survives uncertain
primary unlink settlement; its identity and bytes are checked again after the
primary sync and descriptor close. Foreign late siblings remain debt and are not deleted.

Installation is limited to a disposable single-project TEST manifest with local
relative tarballs and `packages: []`. Before either install mode spawns, every direct
tarball must be a canonical in-root, single-link regular file read through a bounded,
authenticated descriptor. The supported package format is gzip containing USTAR
or short-name GNU ordinary file/directory headers, with checked framing, checksum,
paths and one bounded `package/package.json`; links and extension records refuse.
The package name must match its direct dependency key and its version must be a
three-component numeric version. This checkpoint supports leaf packages with no
`dependencies`, `optionalDependencies`, `devDependencies`, bundled-dependency,
workspace or `pnpm` declarations. Peer declarations remain available to actual
strict pnpm, with automatic peer installation disabled. Limits are 64 direct
packages, 32 MiB compressed and 64 MiB expanded per archive, 64 MiB compressed
and 128 MiB expanded in total, 4096 entries per archive and 1 MiB package manifests.
Unsupported closure or archive admission returns `invalid-selection` before spawn.
Project config/hooks, workspace overrides, remote dependency specifications,
unowned modules and unowned stores refuse. The selected Node directly executes
actual pinned JavaScript pnpm with scripts ignored, strict engines and peers,
automatic peers and manager switching disabled, copy imports, verified store
integrity and a private store. Prepare and frozen replay both pass `--offline`.
Frozen replay additionally requires `--frozen-lockfile` and a separate actual
`pnpm peers check --lockfile-only`;
a failed peer preparation cannot become a positive frozen replay. Manifest,
workspace, root and virtual locks, tarball integrity and runtime identity are
rechecked. Root deletion remains contingent on finite settled process facts
and independently checked physical custody; facts are not an external settlement service.

Repository test selection explicitly assigns six private managed-runtime suites
to Linux x64 through the finite policy in `scripts/check-test-manifests.mjs`.
The three restored suites and typed custody suite join observation and process
in canonical shard 4 and its coverage projection, without changing mandatory
identities or shrinking the portable inventory. Historical inventory counts are
not current qualification. Windows, Darwin and other Linux architectures retain
every portable suite, including actual unsupported-platform refusal in
`managed-portable-profile.test.mjs`; refusal does not qualify Linux effects.
Linux shard 4 retains the pinned Nodes from the existing Actions setup and
restores Node 24 as default before provisioning and testing.
`scripts/provision-managed-test-tools.mjs` downloads the exact declared JavaScript
pnpm package from the public npm registry, verifies its metadata and SHA-512
integrity, and extracts it into runner-private TEST storage. The self-contained
`pnpm/setup` executable has no package manifest and cannot supply the direct-Node
positive tuple. Both Node versions and both Node-plus-pnpm versions must pass
before the script exports the TEST paths.
Tests require actual supplied tools through `MANAGED_TEST_TOOLS_ROOT` and fresh
TEST roots through `MANAGED_TEST_ROOT`. Synthetic packages exercise rejecting
or process-mechanics cases; real positive observations use actual pnpm. UID-0
runs explicitly skip denied cleanup; that skip proves no permission guarantee.
Compiled source must be rebuilt before any gate. Root must typecheck the new
production contracts and the `.mts` custody suite with TypeScript, not Node type
stripping, then run the focused suites against genuine Node 24.21.0 and 26.10.0
and JavaScript pnpm 11.20.0 in fresh disposable TEST roots. Source-only production
of this checkpoint executes no gates. Required changed, fast, security and focused
checks precede handoff; final independent review and the complete requested
full-CI native matrix must bind the exact final head/base. `pnpm verify` remains
the full local diagnostic path when hosted qualification cannot run or leaves a
changed risk uncovered, according to current repository instructions.

Hash-before/hash-after checks and directory-identity fences are not atomic
protection against transient same-UID swaps of the selected Node, pnpm tree,
owned workspace or its parent between a check and the later spawn, working
directory resolution or recursive removal. Host must keep provisioned artifacts
and the private root cooperatively quiescent. Detached sessions remain outside
cooperative process-group containment. Provisioned TEST bytes prove neither
vendor authenticity nor central authorization.
Artifact provenance, managed behavioral receipts, canary, release, consumer
adoption, activation, backup and recovery belong to later checkpoints/owners.
