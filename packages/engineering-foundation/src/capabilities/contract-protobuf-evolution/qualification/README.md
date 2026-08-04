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

Configuration schema v2 is required. Schema v1 remains shipped as immutable
historical contract data but cannot prove qualified `FILE` provenance and is not
accepted by the executable capability.
