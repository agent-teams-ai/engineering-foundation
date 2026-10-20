# Runtime profile guidance review evidence

This directory retains non-authoritative review inputs for the
[runtime-profile seam](../../runtime-profile-static-seam.md). The canonical
standard stays in Get Modular. No accepted ADR or adopted FMS bytes change.

- `common-assembly.txt` is the complete upstream document at Get Modular commit
  `3dd68a6b26f42159714a4640b613534a55c2c6aa`, observed as `main` through `gh`
  on 2026-10-18. Its exact identity is in `common-assembly.provenance.json`.
- `common-assembly.diff` is the complete document delta from the previously
  reviewed commit `7d6535dd86533566620040233290869825000d2b`, whose document
  SHA-256 is `859fbca1e8a0c61b6ae873bea0057735a55b80230100e6e73a74de22e123165a`.
  The diff SHA-256 is
  `f1b259ad7dfde879dff1c4c073fa46772427d35e6034ff6083a31895ac8a421b`.
- The current CMS bytes are identical to the separately retained process-runtime
  section 6 review at Get Modular commit
  `ccd815eac780b603a4cb6d01d07c995348c7b0f5` (SHA-256 `e5cb510c5ea83e54a6833cc40b6ad31fc5cf8c70d9838e4e0c6923edc6f70919`).
- Organization `main` was observed through `gh` at
  `3a203362c25c5ebbe6e44b745ba3f8a5eecbaad0`. Its complete EQS bytes match
  Foundation's accepted `f5653f5630057524a4ee44e50c16e138442a9b42` pin,
  blob `86b82be3e5bd212e7d78e50d92349e323026347e`, SHA-256
  `a65fb5150837b010a71abe36cefd26c32709eb9b9e89f3938498a647e72f5587`.
  The existing `standards/engineering-quality-standard.md` and provenance remain
  the retained authority inputs; no content migration is necessary.

Retrieve inputs with `gh api -H 'Accept: application/vnd.github.raw+json'
repos/<repository>/contents/<path>?ref=<exact-commit>`. Resolve links in the CMS
snapshot relative to `docs/architecture/` in `agent-teams-ai/get-modular` at
the recorded commit, rather than relative to this evidence directory.
The `.txt` extension keeps those upstream relative links out of Foundation's
Markdown reference inventory without changing any source bytes or exclusions.

The full current CMS and full delta were reviewed. Entries/groups replace
bound handles; provider/root oracles replace full row tables; the FMS v1.1
layout guidance adds optional sub-features and composition contracts. Foundation
continues to pin FMS v1 and the seam remains a classified fixed dependency,
without Assembly adoption. These changes require no runtime wiring migration
for this scope. The seam records the reasoning and future adoption trigger.

`pnpm standards:check` authenticates retained CMS/EQS bytes and identities,
the retained delta digest and the seam's unique current guidance fields.
`tests/engineering-quality-standard.test.mts` rejects stale guidance,
missing/tampered retained inputs and changed provenance. Both existing fast and
full check chains already invoke `standards:check`; this evidence does not
claim Assembly or repository-wide CMS conformance.
