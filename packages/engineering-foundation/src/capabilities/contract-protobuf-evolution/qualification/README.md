# Buf Qualification Boundary

This namespace owns the explicit process boundary behind:

```text
agent-teams-foundation protobuf-qualify-breaking \
  --consumer . \
  --buf-executable /absolute/path/to/pinned/buf \
  --write
```

It is not registered as a normal Foundation capability. Normal `check` execution
never imports its process adapters, starts Buf, opens a shell or accesses the
network. The command is invoked explicitly by a protected consumer workflow.

Write mode runs the pinned Buf executable and atomically emits canonical,
versioned evidence. Check mode omits `--write`, reruns the same qualification and
requires byte-for-byte equality with committed evidence. Consumers own the Buf
pin, workflow protection and review policy; Foundation owns invocation semantics,
normalization and evidence validation.

Candidate construction must match the declared descriptor digest. Breaking
analysis supplies one canonical inline Buf v2 `FILE` configuration through both
`--config` and `--against-config`, rather than reopening the mutable repository
config for policy execution. Processes have a bounded deadline and process-tree
cancellation; evidence publication is locked, contained, atomically replaced and
verified after rename.

Capability configuration schema v2 and qualification evidence schema v2 are
required. Their version 1 predecessors remain shipped as immutable historical
contract data but cannot prove hardened `FILE` provenance and are not accepted
by the executable capability.

The pre-1.0 migration is explicit: move released fields into the separate
release-owned baseline, declare `qualification` and `current` under capability
schema v2, then run the protected qualifier with `--write`. Review the resulting
evidence v2 digest before recording any breaking approval. No v1 evidence or
approval fingerprint is carried forward implicitly.
