# Selective Quality Gate Tool Spikes

Status: Execution evidence and adoption recommendations. Only the optional
external-link workflow is implemented by this change; no new consumer capability
or blocking package policy is introduced.

Date: 2026-10-26

Source examined: `9dd052aa697095a57718cfd863b2efdee469d5d7`.

## Decision

The [dev-quality-gates catalog](https://github.com/mokevnin/dev-quality-gates)
was evaluated against Foundation's existing checks, not treated as a tool list
to install. The executed follow-up spikes support these decisions:

| Candidate | Decision | Evidence that matters |
| --- | --- | --- |
| Lychee 0.24.2 | Separate optional weekly/manual workflow | Active documentation has a small external-link surface; no PR job or Foundation dependency installation is needed |
| agnix 0.59.3 | Do not add a mandatory Foundation profile | Actual instruction files produce false blocking; no newly confirmed substantive defect was found |
| Squawk 2.70.0 with Drizzle | Defer to a concrete PostgreSQL consumer and migration execution policy | One transaction rule's assumptions disagree with the tested Drizzle migrator |
| Existing publint 0.3.22 with `--strict` | Keep the current default gate | Current packages are clean in both modes; tested runtime/exports failures already fail native qualification |

The Dependabot documentation is corrected separately: `open-pull-requests-limit:
0` intentionally disables ordinary version-update PRs. This change neither
reactivates them nor claims to have verified repository security-update settings.

## Agnix: useful structure checks, unsuitable mandatory profile today

Agnix statically checks agent instructions, skills, hooks and MCP/configuration
files. A pass cannot establish that an agent loaded or executed a mechanism.
The official Linux binary was verified against its release SHA-256 before use.
There were 33 validation invocations across 23 fixture directories and the four
actual production instruction files: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and
`.github/copilot-instructions.md`.

| Actual-file profile | Errors / warnings / info | Exit |
| --- | --- | ---: |
| Default | 0 / 1 / 2 | 0 |
| Selected agents, `prompt_engineering = false` | 0 / 2 / 2 | 0 |
| Same, strict | 0 / 2 / 2 | 1 |
| Same, two exact per-file suppressions | 0 / 0 / 2 | 0 |

The important counterexamples are:

- `CDX-AG-005` treats the inline-code label of the external organization link
  `scripts/merge-owner-pr.mjs` in `AGENTS.md` as a missing local file. Copying the
  organization-owned script into Foundation would be an incorrect remedy.
- Selecting Gemini and Copilot also applies `COP-030` to Gemini's intentional
  `@AGENTS.md` adapter. Disabling prompt-engineering rules alone does not remove
  all cross-tool or stylistic noise.
- `.codex/config.toml` with `approval_policy = "untrusted"` and
  `sandbox_mode = "read-only"` is rejected by `CDX-CFG-001` even with
  `[tool_versions] codex = "0.146.0"`. The official Codex 0.146.0 schema, matching
  Foundation's pin, explicitly accepts that approval value.
- `.mcp.json` with `{"mcpServers":{"fixture":{"command":42,"args":[]}}}`
  passes strict with one checked file. Empty and fully excluded inputs also
  return success with zero checked files. Strict is not complete schema or
  input-inventory validation.

Useful negative controls did fail: malformed skill YAML, missing generic skill
description, invalid hook event/type/JSON, missing hook script, malformed MCP
JSON, non-array MCP args, malformed Codex TOML and invalid sandbox mode. JSON and
SARIF retained failure exit codes. No autofixes or hook/MCP execution occurred.

Reconsider agnix for a consumer with real structural inputs, an exact vendor
version contract, positive/negative fixtures and an asserted file inventory.
Adding a config to suppress today's noise in Foundation has no demonstrated
additional benefit.

Sources: [release](https://github.com/agent-sh/agnix/releases/tag/v0.59.3),
[configuration](https://github.com/agent-sh/agnix/blob/v0.59.3/docs/CONFIGURATION.md),
[rule evidence](https://github.com/agent-sh/agnix/blob/v0.59.3/knowledge-base/rules.json),
[Codex 0.146.0 schema](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/config.schema.json).

## Squawk and Drizzle: execution context is part of correctness

The isolated spike used Squawk 2.70.0, drizzle-orm 0.45.4, drizzle-kit 0.31.11,
PGlite 0.5.12 and TypeScript 7.0.2. The executed TypeScript spike was checked with
the actual strict compiler. Drizzle Kit really generated the initial table/index,
an added index and a column type change; these were not handwritten substitutes.

Squawk detected an index on an existing table and a potentially unsafe column
type change. `--assume-in-transaction` correctly avoided a concurrent-index
warning for an index created with its new table. SQL extraction/invocation is
straightforward; interpreting fixes requires the actual migration executor.

The important counterexample is a one-statement file:

```sql
CREATE INDEX CONCURRENTLY "widgets_label_idx"
ON "widgets" USING btree ("label");
```

Squawk's `ban-concurrent-index-creation-in-transaction` rule does not report this
statement even with `--assume-in-transaction`. A narrow profile excluding
`prefer-bigint-over-int`, `prefer-robust-stmts`, `require-lock-timeout`, and
`require-statement-timeout` therefore returns exit 0 and `[]`. The full profile
does return nonzero for other warnings; it is not claimed to give a clean pass.
Timeout rules are operational policy, not merely style.

The actual `drizzle-orm/pglite` migrator rejected the same migration with
PostgreSQL SQLSTATE `25001`: concurrent index creation cannot run in a
transaction. The index was absent and the migration journal remained at one
applied migration. An ordinary index passed the same route, created the index,
and advanced the journal to two migrations. Explicit `BEGIN`/`COMMIT` around the
concurrent index is detected by Squawk.

The exact Squawk rule only reports when `stmt_count > 1`, with an upstream test
allowing the singleton case. Drizzle's tested common PostgreSQL dialect wraps
pending migrations in `session.transaction`; that route does not grant a
singleton migration a transaction exception.

This is a real PostgreSQL WASM execution, not a mock. It is not native PostgreSQL
deployment/load evidence, a test of every Drizzle driver, or a qualification of
`drizzle-kit migrate`. Adopt advisory SQL diagnostics only with a selected
consumer; a blocking gate also needs the executor's transaction contract.

Sources: [Squawk rule and tests](https://github.com/sbdchd/squawk/blob/v2.70.0/crates/squawk_linter/src/rules/ban_concurrent_index_creation_in_transaction.rs),
[Drizzle migration documentation](https://orm.drizzle.team/docs/migrations),
[PGlite](https://pglite.dev/).

## Publint strict: compatible, but no material new requirement demonstrated

The spike used the existing exact publint 0.3.22. Its isolated transitive tools
matched the repository lock: `@publint/pack` 0.1.6,
`package-manager-detector` 1.8.0 and `tinyexec` 1.2.4.

| Inventory | Default | Strict |
| --- | --- | --- |
| Ten current published npm tarballs | 10/10 clean | 10/10 clean |
| Ten built/staged source packages | 10/10 clean | 10/10 clean |

The exact catalog versions were ci-input-proof 0.1.3, release-checks 0.1.0,
repository-mutation 0.4.2, document-authoring 0.3.6, docs-protocol 0.6.6,
docs-protocol-agent-teams 0.5.5, docs-protocol-mcp 0.2.9,
engineering-foundation 3.0.0, feature-module-standard 0.3.0 and stack-toolchain
0.1.1. The first nine use the `@agent-teams/` scope. Published SHA-512 tarball
integrities were independently recomputed and matched registry metadata.
Source staging used the real publication function, including document-authoring's
Markdown projection, under Node 26.11.1 and Bun 1.4.3.

Six controlled packed fixtures were compared with both publint modes and the
real native qualifier using TypeScript 7.0.2:

| Fixture | Default | Strict | Existing native qualifier |
| --- | ---: | ---: | ---: |
| Clean ESM package | 0 | 0 | 0 |
| Invalid `repository.url` | 0 | 1 | 0 |
| CommonJS content in a file declared as ESM | 0 | 1 | 1 |
| Exported JSON glob matches no packed file | 0 | 1 | 1 |
| Deprecated GitHub `git://` URL suggestion | 0 | 0 | 0 |
| Exported declaration file missing | 1 | 1 | 1 |

There were 58 final invocations: 40 inventory comparisons, 12 publint fixture
comparisons and six native comparisons. This is not a claim that all possible
publint warnings duplicate native checks. The native comparison covered the six
fixtures; full native qualification of the real inventory is a separate gate.

Strict adds no process or dependency and did not regress current packages. Its
only demonstrated unique rejection here concerns repository metadata. Keep the
existing gate until an additional warning category becomes an explicit release
requirement; reevaluate new warnings when updating the pinned tool. No published
package defect was discovered by this spike.

Sources: [publint CLI](https://publint.dev/docs/cli),
[message reference](https://publint.dev/rules).

## Lychee adoption boundary

The implementation and reproduction command are documented in
[Optional external documentation links](../development/quality-gates.md#optional-external-documentation-links).
An actual network run on the selected documentation completed in 4.25 seconds:
21 successful external URL entries, zero errors and zero timeouts. Relative
links and other intentionally excluded entries remain owned by existing gates.
This is one local observation, not a hosted-runtime guarantee.

The exact workflow shell also passed 11 controlled scan scenarios and two
installer scenarios. A real local HTTP server supplied successful responses,
redirects, 404, 429, 503 and a five-second request timeout. Findings remained
visible while the advisory shell succeeded. Empty, malformed, missing and fully
excluded inputs were marked incomplete. Private/example/code/mail exclusions
sent no requests. The overall-budget branch used the real GNU `timeout` with a
test-only one-second duration; production retains 120 seconds. The exact
installer accepted the verified official archive and rejected a one-byte
corruption before extraction/execution. The installer test substituted only the
download transport; the actual release download was separately exercised.

No new npm dependency, public API, consumer activation, required PR check, or
publication warning policy is introduced. Independent criticism confirmed the
three non-adoption decisions and required the narrow-profile/driver limitations
above to remain explicit.
