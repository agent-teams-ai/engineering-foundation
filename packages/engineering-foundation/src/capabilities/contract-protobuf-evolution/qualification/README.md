# Buf Qualification Boundary

This namespace is an internal donor and conformance harness for Foundation's own
tests. It is deliberately not exported by the consumer package, is not a normal
Foundation capability, is not registered by the check runner, and must never be
called by a normal capability check or imported by consumer CI.

Each consumer instead owns an equivalent pinned producer workflow in its own CI.
That workflow invokes the consumer's pinned Buf executable and persists only
deterministic release evidence for the pure `contract-protobuf-evolution`
evaluator. The evaluator does not execute subprocesses, inspect Protobuf domain
semantics, or decide transport behavior.
