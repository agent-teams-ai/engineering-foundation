# Repository Mutation

`@agent-teams/repository-mutation` is the zero-monorepo-dependency leaf for the
cooperative repository operation lock, bounded state evidence, closed known-file
transactions, exact receipts, and exact-artifact recovery.

Standalone callers protect the shared lock and common transaction evidence. They
do not classify an unaccompanied Engineering Foundation local-mode backup; full
Foundation local-mode admission remains the responsibility of Foundation's
composition wrapper.

Known-file Plan compilation rejects portable case/NFC collisions and every
ancestor/descendant relationship across the complete operation set before the
Plan digest, journal, or filesystem effects. The path alphabet remains ASCII-only;
both composed and decomposed non-ASCII paths are rejected. Valid operation order and digest
semantics remain v1-compatible. Persisted v1 evidence is never rewritten:
correct journals use only their exact owner-and-kernel build recovery route.
Foreign builds cannot take over; impossible, corrupt, or unknown historical bytes
remain a manual-only mutation barrier. Known-file apply and recovery remain unsupported
on Windows and fail before effects; pure Plan compilation remains portable.

For a valid interrupted journal, use `recoverKnownFileTransaction` from the
recorded owner and kernel artifacts, matching each name, version, and
`buildIdentity`: `APPLYING` rolls back and `COMMITTED` completes cleanup. A
rebuilt package with the same version cannot take over. Preserve the recorded
artifact for the supported recovery window. Impossible historical Plans and
unknown evidence require manual resolution; no automatic bridge, schema rewrite,
or cleanup is authorized. A failed recovery keeps the journal and mutation barrier.

Current JSON Schema imports use the package's
`./schemas/repository-mutation/known-file-transaction-plan/v1.schema.json` and
`./schemas/repository-mutation/known-file-transaction-receipt/v1.schema.json`
exports. Their IDs have the same `repository-mutation/` prefix. Both retain wire
version 1 and protocol `agent-teams.repository-mutation.known-file/v1`; compiler,
receipt digests, and the current transaction envelope (wire version 6) are unchanged.
The unprefixed Plan and Receipt schema exports retain exact Foundation 0.21.0
bytes and protocol `foundation.replace-known-file/v1`. They describe historical
data and do not enable the current compiler or journal reader to resume it.

Recover compatible historical known-file journals only through `./mutation` in
the retained exact `@agent-teams/engineering-foundation@0.21.0` artifact, matching
its recorded build. Impossible Plans or ambiguous partial effects remain manual.
Current public declarations and executable exports stay unchanged. The schema
correction requires Authoring, Foundation, and Managed reference closure before
the coordinated package set can be published.
