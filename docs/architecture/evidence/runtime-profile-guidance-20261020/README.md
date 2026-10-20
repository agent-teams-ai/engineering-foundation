# Runtime profile and workflow guidance review evidence

This directory retains non-authoritative inputs for the
[runtime-profile seam](../../runtime-profile-static-seam.md). The canonical
standard remains in Get Modular; accepted ADRs and adopted FMS bytes are unchanged.

- `common-assembly.txt` contains the complete upstream document at Get Modular
  commit `300e7e1c459c08f5e271627e4ca7d2486bdf5e1f`, observed as `main` through
  `gh` on 2026-10-20. `common-assembly.provenance.json` records its repository,
  path, anchor, commit, blob, full-document SHA-256 and size.
- `common-assembly.diff` contains the complete delta from the previous reviewed
  commit `3dd68a6b26f42159714a4640b613534a55c2c6aa`, whose full-document SHA-256
  is `e5cb510c5ea83e54a6833cc40b6ad31fc5cf8c70d9838e4e0c6923edc6f70919`.
  The delta SHA-256 is
  `65b7b1e9d0cc45836fc188ef332ffcc8c35227df6045ef1acde0e8f6b9346af5`.
  The [previous evidence](../runtime-profile-guidance-20261018/README.md) remains
  unchanged, including its older input and delta.
- Organization `main` was observed through `gh` at
  `a34ecc6bc9bb165771f3962dccd25970dd5c0d98`. Its complete EQS document is
  byte-identical to Foundation's retained commit
  `f5653f5630057524a4ee44e50c16e138442a9b42`, blob
  `86b82be3e5bd212e7d78e50d92349e323026347e`, SHA-256
  `a65fb5150837b010a71abe36cefd26c32709eb9b9e89f3938498a647e72f5587`.
  That EQS pin remains current; no content migration is needed.

Retrieve inputs with `gh api -H 'Accept: application/vnd.github.raw+json'
repos/<repository>/contents/<path>?ref=<exact-commit>`. Resolve links in the
snapshot at its recorded Get Modular revision. The `.txt` extension preserves
upstream bytes without adding upstream relative links to Foundation's Markdown
reference inventory.

The complete document and delta were reviewed. The delta adds observation
communication guidance, signal-bound subscription detachment before cleanup,
composition-only access to resources, observation error codes and test-entry
import restrictions with scope leak checks. It retains fixed private helpers
inside their owning feature and Host custody, deadlines and cleanup authority.
The workflow command, custody and check-runner adapters introduce no store,
subscription, Assembly entry or independently owned module lifetime. No
observation, Assembly or lifecycle-kernel adoption follows from this pin review.

`standards:check` authenticates the full retained CMS/EQS inputs and delta,
unique current guidance records, exact seam paths and workflow classification.
`tests/engineering-quality-standard.test.mts` rejects missing or altered inputs,
forged provenance, the previous current pin, duplicate guidance records,
unclassified workflow paths and removed classification. Fast and full checks
already invoke the standards gate. These checks enforce this recorded seam;
they do not certify repository-wide CMS conformance or physical cleanup.
