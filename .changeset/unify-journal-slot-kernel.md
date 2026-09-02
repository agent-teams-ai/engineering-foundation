---
"@agent-teams/engineering-foundation": patch
---

Compose the document-authoring and scaffolding journal stores over one shared
journal slot store in the Foundation transaction-coordination layer. Both owners
keep their released on-disk names, byte formats, fault phases, crash residue,
and error wording; only the duplicated candidate, quarantine, retirement, and
reconciliation mechanics now live in one implementation. The retired
pretty-printed scaffold journal writer is removed; reading the historical format
is unchanged.

Two deliberate hardenings come with the shared store. A journal file that
disappears during a proof now reports the owner's "changed" diagnostic instead
of a raw `ENOENT`. Document authoring now re-proves its candidate immediately
before hard-linking it into the canonical slot and refuses to report a removal
as complete when the canonical slot was recreated concurrently, matching what
scaffolding already guaranteed. Both owners now validate the journal before
probing slot occupancy, so an invalid journal aimed at an occupied slot reports
the contract error first.
