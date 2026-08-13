# Document Authoring Cooperative Writer Threat Model

Status: Intent, Plan, and Receipt v1 remain governed by ADR-0023. Envelope v3,
document journal v2, and recovery-handler contract v2 are accepted by ADR-0024.
Published envelope v2 and journal v1 are immutable manual-recovery evidence.

## Protected assets

- preexisting repository files and directories;
- exact planned output bytes and destination identity;
- consumer authority used to compile a Plan;
- the repository operation lock and active transaction evidence;
- truthful Plan and Receipt digests;
- recoverability after interruption.

## Trusted and cooperative actors

The protocol assumes Foundation-aware writers honor the canonical repository
lock and transaction slot. It trusts the installed exact Foundation package,
its closed recovery-handler registry, the local operating system and Node
runtime, and consumer authority that passes strict decoding and schema checks.

A human editor or another process may change repository files concurrently but
is not assumed to honor the lock. The protocol detects observed drift and fails
closed; it does not sandbox that actor.

## Explicitly excluded attackers and guarantees

The protocol does not defend against a hostile process running as the same OS
user, a compromised kernel or filesystem, malicious package installation,
physical storage attacks, or an administrator replacing evidence underneath the
process. It does not claim identical power-loss durability on ext4, APFS, NTFS,
network filesystems, or virtualized mounts. It also does not prove document
meaning, completeness, or review quality.

## Threats and required controls

| Threat | Required control | Fail-closed result |
| --- | --- | --- |
| Path traversal or platform alias | Portable repository-path grammar and canonical containment | Invalid input before write |
| Symlink, junction, or reparse ancestry | Reject redirected ancestors and recapture ancestry under lock | Unsupported or authority-stale |
| Partial or truncated catalog | Planning requires a complete two-pass catalog within fixed limits | Invalid authority; no Plan |
| Ambiguous identity or placement | Closed ID grammars, exactly one root match, contiguous required segments, and portable collision checks | Invalid input or authority before Plan |
| Slug or destination omitted, unused, or ambiguous | Placement-specific Intent presence matrix and versioned NFKD-to-ASCII slug algorithm | Invalid Intent before Plan |
| Template or metadata ambiguity | One strict fenced skeleton, syntax-aware leading-H1 detection, generic binary map-key order, reserved-key rejection, accessor-free inert JSON inspection, strict YAML round trip, and consumer schema validation | Invalid authority or Intent before Plan |
| Cross-domain digest substitution | `{domain,payload}` canonical JSON preimages for all document-owned digests | Invalid Plan or Receipt |
| Existing destination | Create-no-replace and exact precondition classification | Conflict, never overwrite |
| Existing bytes falsely treated as self | Exclude only exact planned path, bytes, and parsed document ID from the logical preimage | Conflict or unreproducible Plan |
| Authority changes after planning | Recompile and compare exact Plan under lock before publication | `authority-stale` |
| Caller mutates an in-memory Plan | Snapshot, validate, and digest before use | Invalid Plan |
| Journal or payload tampering | Closed schema plus payload and envelope digests | Manual recovery required |
| Unknown or newer journal | Preserve exact evidence and block every Foundation mutation | Manual recovery required |
| Published envelope v2 or document journal v1 | Frozen read-only recognition without handler or recovery authority | Preserve as manual-recovery evidence; never resume mutation |
| Temporary path substitution or inode reuse | Exact Plan-derived sibling plus creator-handle dev/ino/birthtime identity | Reject or preserve for manual recovery; never act on a merely matching pathname |
| Package downgrade or same-version rebuild during a transaction | Exact SemVer plus package build identity in envelope v3, bound to the embedded compiler and closed handler v2 | Preserve evidence; only the exact qualified package may recover |
| Contradictory envelope/document lifecycle | Closed PREPARED/PUBLISHING/PUBLISHED matrix binding destination state, temporary, and publication identity | Manual recovery required |
| Interrupted local attach or detach | Shared coordinator recognizes durable phase or orphan registry backup and admits only detach | All foreign mutations blocked |
| Concurrent Foundation mutation | One operation lock and one physical transaction slot | Recovery required |
| Crash before publication | Durable prepared evidence and exclusive owned temporary | Recover or preserve |
| Crash after publication | Persist PUBLISHED with non-zero `publicationIdentity`; verify exact destination bytes and identity | Complete or recover; never delete output |
| Destination replaced after observation | Repeat bytes, mode, ancestry, and physical identity checks | Preserve output and evidence |
| Parent or ancestor replaced after planning | Recapture the complete physical chain under lock; Plan stores no portable inode promise | Authority-stale, conflict, or manual recovery |
| Temporary identity unavailable on the filesystem | Preserve canonical zero identity evidence; never publish, delete, or auto-recover from it | Manual recovery |
| Same-byte replacement after publication | Require destination identity to equal journal v2 `publicationIdentity` | Manual recovery; never adopt or delete replacement |
| Cancellation races with publication | Report cancellation only after proving no publication and durable cleanup; mask cancellation after possible publication | Complete or preserve transaction evidence |
| Orphan unknown temporary | Delete only a temporary whose ownership and identity are proven | Manual cleanup instruction |
| Remote schema or template | Local-only profile paths and closed Foundation schema references | Invalid authority |
| Resource exhaustion | Fixed byte, item, depth, path, and diagnostic limits | Typed invalid input or execution failure |

## Publication boundary

Before publication, a failed operation may remove only its own exactly
identified temporary evidence. Once a destination has been published or may
have been published, automatic rollback by deletion is forbidden. Matching
bytes, journal state, or process-local memory cannot prove that a noncooperating
writer did not replace the path.

The only permitted responses after that boundary are:

- finish verification and commit;
- preserve destination and transaction evidence;
- resume only with a compatible implemented and qualified recovery handler;
- report manual recovery with stable diagnostics.

Envelope v3 recovery is version-exact, not range-compatible. It requires the
recorded Foundation SemVer and build identity, the closed handler contract v2,
the embedded compiler identity, qualified dependencies, and the exact journal
v2 state matrix. Older packages preserve unknown v3 evidence and block
mutation. New packages preserve v2/journal v1 evidence and require manual
resolution. No package migrates an active journal.

Cancellation is a claim about durable state, not merely an observed signal. It
is truthful only when destination absence is proven and all identity-owned
temporary and journal evidence is durably gone. After publication or ambiguity,
the signal cannot turn the outcome into cancellation.

Legacy recognition and current recovery handlers cannot be retired by age
alone. Retirement requires organization-wide zero-instance inventory, removal
of every supported producing writer, expiry of the declared support window,
recovery-fixture evidence, and a new accepted removal ADR.

## Honest claim

On a qualified adapter, the protocol may claim cooperative serialization,
single-file atomic create-no-replace, exact-byte verification, journaled
recoverability, known ancestry hazard rejection, and no automatic deletion
after publication. It may not claim a hostile-writer sandbox, a true multi-file
transaction, universal crash durability, or semantic correctness.
