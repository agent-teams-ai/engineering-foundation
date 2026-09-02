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
versioned evidence. Check mode omits `--write`, reruns the same capability qualification and
requires byte-for-byte equality with committed evidence. Consumers own the Buf
pin, workflow protection and review policy; Foundation owns invocation semantics,
normalization and evidence validation.

Candidate construction must match the declared descriptor digest. Breaking
analysis supplies one canonical inline Buf v2 `FILE` configuration through both
`--config` and `--against-config`, rather than reopening the mutable repository
config for policy execution. Processes have a bounded deadline and process-tree
cancellation; evidence publication is locked, contained, atomically replaced and
verified after rename.

The single Foundation-owned capability configuration and capability-qualification evidence
schemas are `v1` and include all hardened `FILE` provenance bindings. Older
published package artifacts remain immutable history but their weaker shapes are
not shipped or accepted by the current package.

The pre-1.0 migration is explicit: move released fields into the separate
release-owned baseline, declare `qualification` and `current` under the current
schema `v1`, then run the protected qualifier with `--write`. Review the resulting
evidence digest before recording any breaking approval. No evidence or approval
fingerprint from an older provisional shape is carried forward implicitly.
