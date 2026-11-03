# Explicit-file cleanup

Status: implementation candidate in source. Native qualification, independent
review, publication and consumer rollout are separate steps. Do not infer that an
older installed Stack version implements this command from this document.

## Purpose and ownership

Remove mechanical lint and formatting work without delegating each edit to a
coding agent. Stack supplies a small native-rule preset, the installed tools and
explicit-file execution. The project owns file selection, exclusions, rule policy
and its required tests. Foundation is not a prerequisite.

Installing or upgrading Stack does not activate cleanup, add a Git hook, select
changed files, alter existing lint enforcement or rewrite any source. Existing
`lint`, `format:check` and `runCommand` behavior remains read-only. Cleanup is a
separate `fixFiles` API, not an ignored optional argument to an old check API.

## Usage

After installing an exact release that exposes `fixFiles`:

```sh
stack-toolchain fix -- src/first.ts src/second.ts
stack-toolchain fix --json -- src/first.ts
stack-toolchain fix --lint-config .oxlintrc.cleanup.json -- src/first.ts
```

The `--` separator and a nonempty list of regular files are mandatory. There is no
implicit current directory, Git delta, glob expansion or all-project mode.
Do not pass files owned by another agent just because they appear in `git diff`.
The caller must have exclusive cooperative access to the selected files while
cleanup runs. This is not a sandbox against hostile concurrent filesystem edits.

The command runs syntax-only Oxlint safe fixes, then the existing Oxfmt preset,
then read-only checks of those same cleanup/format configurations. It never adds
`--fix-suggestions` or `--fix-dangerously`, runs typed fixers, downloads tools,
loads JS plugins, sorts imports, stages changes or commits files.
It does not load `toolchain.config.json` or start a compiler. Existing native
linter semantics may still consult supporting project files where applicable.

A single concise completion line is the normal output. JSON retains the selected,
attempted and changed files and the native step results. Nonfixable warnings
remain warnings, not an instruction to refactor until every suggestion is gone.
A completed cleanup is not a successful ordinary lint, typecheck or E2E claim:
run the project's normal focused checks afterwards.

## Default rule selection

| Native rule | Why selected | Boundaries |
| --- | --- | --- |
| `prefer-const` | Communicates stable bindings without manual edits | `destructuring: all`, `ignoreReadBeforeAssign: true`; no forced splitting of mixed declarations |
| `no-useless-rename` | Removes redundant import/export/destructuring aliases | Native safe fixes only |
| `no-useless-computed-key` | Removes redundant literal object keys | Class-member enforcement disabled; preserve special-key semantics |

`cleanup.json` contains only rule settings and can be explicitly composed with a
consumer's diagnostic configuration. It does not reset categories, plugins or
typed options. Consumer overrides remain authoritative.

`cleanup-fix.json` is instead an isolated write configuration: it disables default
correctness-category selection and enables only the three chosen rules. Do not
extend it from ordinary CI configuration; it is not a replacement for baseline
correctness checking. There is one source for rule settings: `cleanup.json`.

For example, a consumer-owned `.oxlintrc.cleanup.json` may contain:

```json
{
  "extends": [
    "./node_modules/stack-toolchain/presets/oxlint/cleanup-fix.json"
  ],
  "rules": {
    "prefer-const": "off"
  }
}
```

Use that file only with `fix --lint-config`. Overrides can select other native
syntax rules; those are consumer policy, not an extension of Stack's qualified
default rule claim. JSON/JSONC inheritance remains data-only and rejects cycles,
JS plugins, `typeAware: true` and `typeCheck: true`, including inherited settings.
No executable configuration escape hatch is added.

`no-extra-boolean-cast` is deliberately absent: removing explicit coercions can
conflict with a consumer's `strict-boolean-expressions` policy. Assertions, type
arguments, runtime checks, Promise handling, error recovery and array algorithms
are not rewritten by the default preset. Neither anti-slop nor ts_slop is
installed. In particular, identity callbacks in `filter`/`flatMap` and allocating
copies through `map` are not presumed redundant.

## Public API

```ts
import { fixFiles } from "stack-toolchain";

const report = await fixFiles({
  cwd: process.cwd(),
  files: ["src/first.ts"],
  signal: new AbortController().signal,
});

process.exitCode = report.exitCode;
```

Callers check for the `fixFiles` export before using an older installed package.
The API accepts an optional positive `budgetMs` and relative `lintConfigPath`.
Ordinary `runCommand` does not accept a new mutation mode or silently reinterpret
an existing field.

The first write contract admits `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`,
`.mjs` and `.cjs`. Non-source formats, mixed unsupported requests, directories,
missing files, path aliases, duplicate/case-normalization collisions, symlinks,
hardlinks and wildcard characters reject before any source write. Shared literal
path protections and bounded process execution are reused from the existing
Stack adapter; new runtime and dependency owners are not introduced.

File selection is explicit write authorization. Oxlint ignores are disabled for
that bounded literal census, and the formatter uses an owned empty ignore file.
The caller must exclude frozen artifacts, generated/vendor code and other
protected files before calling; ordinary project ignore files are not the write
scope authority. Prefer listing the files in the current task over passing an
entire changed-file inventory.

## Failure and cancellation

Exit 0 means the requested cleanup pipeline completed. Exit 1 reports native
remaining errors or formatting differences; exit 2 reports invalid input,
tooling failure or an expired budget. Caller cancellation returns 130; the CLI
preserves 143 for SIGTERM. No incomplete operation is called completed.

Writes are not a cross-file transaction. A tool failure or cancellation after a
write may leave a partial diff. The report retains attempted paths and observed
changed paths; `sourceObservationComplete: false` means the final file state was
not completely established. Never infer that an empty changed list proves no
mutation after an incomplete observation. No blind rollback can overwrite
another writer. Inspect the diff and rerun the explicit operation after resolving
the cause. If process custody is uncertain, temporary controls are retained and
their location is reported rather than deleting files a child may still use.

The native safe-fix classification is not a proof of semantic equivalence for
arbitrary code. Qualification must include concrete before/after execution,
strict compilation, negative semantic fixtures and a second complete run with no
byte changes. The selected files and current tool versions bound that evidence.

## Foundation source workflow

After the repository's normal source build, the self-consumer route is:

```sh
node packages/stack-toolchain/dist/cli.js fix -- packages/stack-toolchain/src/index.ts
bun tools/dev.mts check:changed
```

Select only source files belonging to the current task. Run once after a coherent
edit batch, not after every keystroke. Keep the existing required fast, full,
platform and release checks; cleanup never qualifies or replaces them.
