# CI parallel qualification delivery

Owner-approved scope, 2026-10-03. Baseline main:
`18dad41b62d1121ad80098023f566228c01287e5`.

## Guarantees

- Preserve every canonical Windows-admitted test exactly once across isolated
  jobs, all mandatory identity checks, and serial execution within each job.
- Preserve Linux's four coverage shards and existing platform exceptions.
- Retain every packed/registry consumer, two independent clean builds for each
  publishable target, archive comparisons, custody, input identity and cleanup.
- Each consumer group owns its own temporary directories and registry instance.
- Every required job failure, cancellation, missing result or omitted group must
  reject the aggregate gate. Timings remain advisory, never selection authority.
- Full exact-head CI and independent review are required before autonomous merge.
  No release publication is authorized.

## Windows lane contract

The Windows writer owns `scripts/run-test-shard.mjs`, the new typed Windows
partition helper/tests and any necessary existing test-manifest behavior tests.
Root owns workflows, package scripts, test registration, policy and documentation.

Split existing shard 1/4 lane into separate jobs. Split shard 3 into the installed
loader CLI test and its remaining files. Keep shard 2 in its own job. The fixed
five-lane dispatch must reject missing pinned entries and prove its disjoint union
equals the full platform-filtered canonical inventory, including future files.
Do not derive CI selection from a timing artifact or change test identities.

Observed run 37131683860: shard 1 approximately 993 seconds; shard 4 approximately
803; shard 2 approximately 856; shard 3 loader CLI file 825; remaining shard 3 769.
These are planning evidence, not latency guarantees.

The later main run `37136363590` passed in 30:25, with Windows package 29:59
and Windows tests A/C 28:38/28:05. Its unchanged Linux shard 3 took 19:32,
followed by 0:32 coverage aggregation. That observation puts the full-run
forecast near 20 minutes even if the Windows split reaches 15-18 minutes;
the original 16-minute lower estimate is not established by this baseline.

## Package lane contract

The package writer owns the private archive producer, packed/registry qualification
scripts and new typed consumer-group entry/behavior tests. Root owns workflows,
package scripts, test registration, policy and documentation. Writers must not
edit each other's scope or revert others' work.

Archive preparation dominates the observed Windows lanes: approximately 10.5
minutes for packed qualification and 13.3 for registry. Use bounded parallel
target preparation with physically independent staging trees; preserve both
independent clean builds per target. Deterministic result ordering, bounded
admission and draining all admitted tasks before cleanup are mandatory, including
rejections with `undefined` as their reason. There is no cross-process archive
reuse or authority from reopening a manifest.

Expose only closed named independent consumer groups. Default standalone and
combined commands still run the complete qualification. Group union must retain
all existing phases, npm/pnpm profiles, rollback, installed bytes, lock/archive
metadata and Buf obligations. Each group can retain the full six-target producer;
bounded target concurrency reduces that preparation's wall time. No arbitrary
package/path override or caller-supplied registry authority is introduced.

The Windows package matrix contains `integration`, `sdk-growth` and
`quality-coverage`; the registry matrix contains `npm-docs`, `pnpm-docs` and
`foundation`. Both retain `fail-fast: false` so an independent failure cannot
cancel the remaining evidence. The mandatory Windows aggregate depends on both
matrix job IDs as well as all five test jobs. Each matrix member starts with its
own fresh all-six-target archive production; a group's name does not authorize
an archive subset or access to another member's temporary files.

## Verification and classification

New handwritten Node tooling/tests use TypeScript with strict CI-tooling checking.
Tests must demonstrate real inventory, scheduling, lifecycle or dispatch behavior,
not merely inspect source text or mirror implementation constants. Focused checks
run on disposable TEST projects; agent runtime/provisioning/launch/assignment
tests must never use real user projects. Hosted model is GPT-6.1 xhigh, default
service tier, no FAST; heavy verification remains on the host.

These are private helpers under existing CI/test/qualification ownership, with no
new production module, capability, adoption profile, public API or package pin.
The retained Consumer Module Standard input at `6b31f20fe3e5fb8324812aa2ee907905751cde71`
was compared with upstream `a01a129d39fe6574dba39e6187bb03ef6bcf9945`. Its delta adds
the optional dynamic Host lifecycle candidate. That scope is absent here; fixed
private helper classification remains unchanged. No adoption migration is claimed.

Integration must retain fail-closed workflow/security/release policy tests and
measure the final full run. The 16-20 minute target is a forecast to validate,
not a reason to omit a check or report completion without platform evidence.
