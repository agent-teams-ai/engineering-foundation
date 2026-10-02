# Private managed runtime observation (P2a)

Status: unselected, feature-private source checkpoint under proposed
[ADR-0056](../decisions/0056-bounded-qualified-managed-node-26-transition.md).
Node 24 remains production/default. Existing stable Cohorts and historical
upgrade/restoration contracts retain their bytes and behavior.

`docs-protocol-agent-teams/consumer-integration` owns the application observation
port and pure supplied-tuple comparison. Its Node adapters own physical identity,
child execution and cleanup. `composition/managed-runtime.ts` is a typed factory
with explicit Host inputs. Construction performs no IO or runtime selection.
The scope exposes only `admit`, `observe`, and `close`; package/application API
exports and managed CLI routes do not expose this seam.

Host supplies an absolute provisioned Node executable, a complete physical pnpm
package root, independently trusted pre-provisioning SHA-256 digests, a private
non-consumer workspace, and cancellation. Admission snapshots data descriptors,
creates one owned directory and issues a factory-local handle. Forged, foreign
or closed handles refuse. This handle conveys observation authority only.

The supported TEST tuples are linux/x64 Node 24.21.0 or 26.10.0 with pnpm
11.20.0, launched by the absolute selected Node. Corepack and other platforms
refuse. Identity binds executable bytes and metadata, manifest/bin entry and the
whole pnpm tree. Aliases, tree links, hardlinked/special files, oversized inputs,
malformed manifest/bin selection and byte or physical identity changes refuse.

Final repaired process and probe sources are retained together. The fixed
compiled probe SHA-256 is
`9f0c6946a07b9cd2e98727352768fb311e13ca4c08fa0f095d8f4b20c2eab671`.
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

Current supplied CMS is Get Modular revision
`9c722ceff4ede307d06d7a4b63fdebe615f54c53`, full-document SHA-256
`33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd`.
Its current private-helper classification applies here: fixed static dependencies
and typed factories within one cohesive feature, with consumer-owned ports and
outer composition. These helpers are not independently assembled graph nodes.
No Core, Assembly, SPI, platform service or lifecycle-kernel dependency is added.

ADR-0056 records historical CMS 6b31f20/d555dfd4 with full-document SHA-256
`d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f`.
R207 authenticates those historical bytes; the now-supplied full document was
hashed and compared to current full bytes. The only delta is ADR-0029 in the
related list and the optional dynamic Host lifecycle section. Static private-helper
classification and passive adoption obligations are unchanged.
The historical ADR remains unchanged. The added section requires whole-graph
rejection before imports, construction custody and authority rechecks after
awaits; observer timeout does not release work. Those dynamic obligations do
not migrate this fixed private seam or Runtime's retained passive consumer pin.
Foundation has no active CMS adoption pin requiring migration for this seam;
current classification and existing admissions ship together with full-byte evidence.
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

The preserved 505-line observation and 291-line process suites exercise P2a
without attempts or installation, including the factory-inertness case.
The final attempt, attempt-close and pnpm
engine/peer enforcement suites remain in the exact retained P2 source for P2b,
unintroduced here, not deleted to green P2a. P2b owns durable root exclusion,
disposable install/store, strict engine/peer enforcement and late-sibling repairs.
No P2b enforcement or installation qualification follows from this checkpoint.

Repository test selection assigns the two private observation/process suites to
Linux x64 only, through the finite policy in `scripts/check-test-manifests.mjs`.
They remain in the complete 275-file inventory and Linux x64 coverage. Windows,
Darwin and other Linux architectures retain every portable suite, including actual
unsupported-platform refusal in `managed-portable-profile.test.mjs`; refusal does
not qualify Linux effects.
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
Compiled source must be rebuilt before any gate. Full `pnpm verify` remains
required before opening a PR; focused and fast evidence does not replace it.

Hash-before/hash-after checks and directory-identity fences are not atomic
protection against transient same-UID swaps of the selected Node, pnpm tree,
owned workspace or its parent between a check and the later spawn, working
directory resolution or recursive removal. Host must keep provisioned artifacts
and the private root cooperatively quiescent. Detached sessions remain outside
cooperative process-group containment. Provisioned TEST bytes prove neither
vendor authenticity nor central authorization.
Artifact provenance, managed behavioral receipts, canary, release, consumer
adoption, activation, backup and recovery belong to later checkpoints/owners.
