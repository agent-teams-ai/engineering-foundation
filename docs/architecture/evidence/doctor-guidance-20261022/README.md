# Stack Toolchain doctor CMS guidance review

The canonical authority remains Get Modular. The exact upstream main observed
through gh on 2026-10-22 is `eadd9d391657ae6f508a874dd30e923bdc4054f0`. Its complete
document bytes are identical to the reviewed retained input at
`7131d0d7a6bb5dd4c3e8906ccac065c0be0e0333`; that explicit reviewed revision is the
new current pin. `common-assembly.txt` and its provenance retain all 81946 bytes,
Git blob `dad8b6280cf999d9079d3106094e5626b63d83f4`, SHA-256
`a6dac5d303adf80be3151c6703c919b715fd880a941a4ad68e927c87a7ee5882`.

The exact complete delta from the previous current 300e7e1 input is retained as
`common-assembly.diff`, SHA-256
`1caa65055dcde91309e2317d70faf339cd82b2ba42f16a8902bc3025cf4f1bf3`. Previous full
input, provenance, delta and accepted decisions remain unchanged in
[historical evidence](../runtime-profile-guidance-20261020/README.md).

The seven added lines require observation load drain to retain its active loader
after escalation, report `observation.load.still-running`, and retain the original
close promise, control and infrastructure after a bounded Host wait. Re-observing
the flight must not retry cleanup. Doctor has no observation subscription, loader
or independently owned lifetime. Existing static adapter classification under
ADR-0064 and Stack Toolchain's process dependency on node-or-bun therefore remain
applicable; no Core/Assembly/lifecycle-kernel adoption or central standard change
is warranted. The reusable command/report and existing process mechanism are used
without a new manager or public contract.

The existing standards gate authenticates complete current bytes/provenance and
reviewed delta, rejects stale current pins and checks unique static seam guidance.
The existing rejecting test now also refuses the previous 300e7e1 pin as current.
Core's separate EQS pin is unchanged by this bounded CMS migration; this record
does not claim that EQS was migrated or all future F3 guidance adopted.
