# Authentic legacy scaffold observation fixture

These are verbatim read-only copies from the retained disposable TEST root:

`/var/data/sandboxes/ef-resume-20260907/TEST-historical-scaffold-execution-0514/output/TEST-cases/TEST-H09-refusal/.agent-teams-local/`

- `journal.json` copies `scaffolding-transaction.json`, SHA256
  `3074e6236ab42b31bc15dd8a1b841948a9832ae1e2c5b8e63be51f79629d2562`.
- `operation-lock.txt` copies `foundation-operation.lock`, SHA256
  `03ab7c770c63c1a2cf612242626647fae7663cb38b87d2d605aa50b5935f326e`.

The unchanged shipped Foundation 0.9.0 writer produced this schema-1 PREPARED
journal with operations `published,pending,pending`; its Plan digest is
`sha256:15bba7607a7f806331686c087a355dfe0d72808acb13a93d9712b9b450a9c883`.
The retained experiment then used Foundation 1.1.0 / Mutation 0.2.0 refusal,
which produced the regular barrier. Exact-old recovery could not enter because
it requires a directory lock. The original case remains PRESERVED-INCOMPATIBLE,
with no successful recovery receipt or replays.

Provenance and limitations were recorded in
`/tmp/ef-historical-scaffold-final-acceptance-fast-20260908-artifacts/REPORT.md`
and independently reviewed in
`/tmp/ef-legacy-lock-scope-critique-fast-20260908-artifacts/REPORT.md`.
These copies qualify recognition and refusal in disposable test directories;
they do not recreate the original authority tree, execute an old writer, prove
old recovery after refusal, or establish a live consumer's admission. Embedded
consumer facts are historical test evidence, not Foundation product policy.
Tests never execute embedded output or modify the retained TEST source.
