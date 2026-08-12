# Document Authoring Cooperative Writer Threat Model

Status: Accepted contract boundary. The document authoring runtime is not yet
implemented.

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
| Existing destination | Create-no-replace and exact precondition classification | Conflict, never overwrite |
| Authority changes after planning | Recompile and compare exact Plan under lock before publication | `authority-stale` |
| Caller mutates an in-memory Plan | Snapshot, validate, and digest before use | Invalid Plan |
| Journal or payload tampering | Closed schema plus payload and envelope digests | Manual recovery required |
| Unknown or newer journal | Preserve exact evidence and block every Foundation mutation | Manual recovery required |
| Package downgrade or same-version rebuild during a transaction | Exact version plus executable/schema/preset build identity in the envelope, bound to the embedded compiler | Recovery with the exact compatible build required |
| Concurrent Foundation mutation | One operation lock and one physical transaction slot | Recovery required |
| Crash before publication | Durable prepared evidence and exclusive owned temporary | Recover or preserve |
| Crash after publication | Verify exact destination and preserve journal | Complete or recover; never delete output |
| Destination replaced after observation | Repeat classification and identity checks | Preserve output and evidence |
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
- resume with the exact compatible recovery handler;
- report manual recovery with stable diagnostics.

## Honest claim

On a qualified adapter, the future protocol may claim cooperative serialization,
single-file atomic create-no-replace, exact-byte verification, journaled
recoverability, known ancestry hazard rejection, and no automatic deletion
after publication. It may not claim a hostile-writer sandbox, a true multi-file
transaction, universal crash durability, or semantic correctness.
