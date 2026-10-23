# Stack Toolchain CMS input review

Canonical authority remains Get Modular, not this retained input. The exact
upstream main observed through `gh` on 2026-10-21 is `7131d0d7a6bb5dd4c3e8906ccac065c0be0e0333`.
The complete document bytes and provenance are retained alongside this record.

The complete delta from `300e7e1c459c08f5e271627e4ca7d2486bdf5e1f` is retained as
`common-assembly.diff`, SHA-256 `1caa65055dcde91309e2317d70faf339cd82b2ba42f16a8902bc3025cf4f1bf3`. The previous
[evidence](../runtime-profile-guidance-20261020/README.md) remains unchanged.

The delta adds seven lines requiring observation load cleanup to retain its
active loader after escalation and report `observation.load.still-running`.
A Host can abandon its bounded wait while retaining the original close promise,
control and infrastructure until completion; it must not retry just to observe
that flight. ADR-0039 is the linked successor decision.

Stack Toolchain has no observation subscriptions or Assembly entries. Its static
checker adapters retain caller-owned process cleanup; no new Assembly or
lifecycle-kernel adoption follows. Accepted ADR bytes and FMS pins are unchanged.
`standards:check` authenticates this input and delta; its rejecting tests also
reject the previous reviewed pin as current guidance.

## EQS successor input

Reviewed exact upstream `.github` main `1b17053bc92766742fec2329ee153171395e658e` on 2026-10-21.
The current complete bytes and provenance live under `standards/`; this directory
retains the previous full input/provenance and exact delta (SHA-256 `962ad4ab851e6d5ebfd782c8887cd5f3dc65f33d866eba7da4e888f4cb524bad`).
The delta adds substantive obligations: neutral public names, external use without
organization credentials or governance admission, documentation before implementation,
and explicit agent routing to the development tools catalog. It does not rename
existing released identities or introduce a new architecture adoption. Stack Toolchain
uses neutral identifiers and standalone install qualification; release availability
and registry-backed adoption remain separately pending. The owning package README
is the released usage authority, and repository instructions must route discovery.
The standards gate authenticates the delta; rejecting tests cover altered delta
and stale EQS current pins. Accepted ADR/FMS evidence remains unchanged.
