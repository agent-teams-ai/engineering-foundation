# Buf Qualification Boundary

This namespace is an explicit consumer CI or adapter-local qualification harness.
It is not a normal Foundation capability, is not registered by the check runner,
and must never be called by a normal capability check.

Consumers that opt in must provide an externally pinned Buf executable, invoke
this boundary in a separate CI command, and persist only deterministic release
evidence for the pure `contract-protobuf-evolution` evaluator. The evaluator
does not execute subprocesses, inspect Protobuf domain semantics, or decide
transport behavior.
