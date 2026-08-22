# Repository Agent Workflow

Status: Implemented and dogfooded. Consumer activation is explicit.

`repository.agent-workflow` gives different coding agents one canonical local
workflow without trusting an agent-specific hook. Foundation owns validation,
changed-file discovery, escalation, and execution. Each consumer owns only its
instruction text, small adapter files, script mapping, and CI invocation.

## Portable instruction contract

- `AGENTS.md` is the canonical repository instruction file.
- `CLAUDE.md` and `GEMINI.md` contain only an import of `AGENTS.md` instead of
  copying or surrounding it with potentially drifting instructions.
- `.github/copilot-instructions.md` directs Copilot to the same canonical file.
- OpenCode and Codex consume `AGENTS.md` directly.

The capability verifies that every configured file is a bounded regular file,
the adapters remain linked, required package scripts exist, and the canonical
instructions name the changed, fast, and full commands. Documentation improves
agent discovery; it is not treated as an enforcement boundary.

## Executable preflight

The consumer exposes three stable scripts:

| Script | Use |
| --- | --- |
| `check:changed` | Feedback while editing; routes changed files through Foundation |
| `check:fast` | Repository-wide fast gate before handoff |
| `check` | Complete authoritative gate used by pull request CI |

`agent-teams-foundation agent-workflow changed` discovers the merge-base delta,
staged and unstaged changes, and untracked files. It invokes configured package
scripts without shell evaluation. Deleted files, policy/control changes, more
than 200 paths, or more than 24 KiB of path arguments escalate to `check:fast`.
Changed symlinks, submodules, special files, control characters, backslashes,
absolute paths, and traversal-like paths fail closed before a consumer script runs.
An exact `--base` ref can be supplied by CI or automation.

The JSON report preserves committed, staged, unstaged, and untracked evidence
as separate sorted groups while retaining `changedPaths` as the backward-
compatible normalized routing union. Each tracked group also records deletions.
The report distinguishes the requested base, its resolved immutable commit, the
current `HEAD` commit, and the unique merge base used for committed scope.
`scopeDigest` is a domain-separated SHA-256 digest over those identities and
groups; it excludes filesystem post-checks and package-script results.

Explicit full refs must be valid exact Git ref names; revision expressions such
as `refs/heads/main~1` are rejected. If an automatically discovered base exists
but no unique merge base can be established because history is shallow or
unrelated, discovery fails closed instead of silently treating `HEAD` as an
empty committed scope.

Discovery disables optional Git locks and fsmonitor observation, external diff
drivers, text conversion, and rename detection. Paths remain strictly
NUL-delimited and must be valid UTF-8. Explicit shorthand refs that resolve in
more than one ref namespace, multiple merge bases, malformed object identities,
or undecodable Git evidence fail closed. Git discovery is read-only and must not
refresh the repository index.

Changed-file checks are an optimization only. A passing result never replaces
the complete `check` command in required CI. Hooks may call the same script for
convenience, but hooks are optional because agents and users can bypass them.

## Effective instructions

```sh
agent-teams-foundation agent-workflow instructions packages/api/src/foo.ts
```

This read-only command explains the repository instruction files that apply to
one caller-selected file. It walks real directories from the explicit consumer
root to the target's directory. In each directory it selects the first regular
candidate in this order: `AGENTS.override.md`, then `AGENTS.md`. The JSON and
text reports show scope, root-to-target precedence, same-directory shadowing,
source and loaded byte counts, SHA-256 digests, the 32 KiB default byte budget,
truncation, and later layers excluded after budget exhaustion. A selected empty
override still shadows `AGENTS.md` but contributes no effective text.

The command models Codex's default project-level discovery. It deliberately
does not read user-level instructions, session state, custom fallback names, or
local Codex configuration, and it never injects or prints instruction content.
Foundation is stricter than Codex about filesystem authority: a selected
instruction symlink or a symlink in the target ancestry fails closed. Digests
cover raw source and actually admitted bytes; the resolution digest binds the
target and ordered admitted sources, not a provider-specific final prompt.
Selected sources above the capability's 256 KiB inspection bound fail closed;
shadowed sources are not read. After the 32 KiB budget is exhausted, later
selected sources are reported from metadata only with a `null` source digest.

The report proves file precedence, not natural-language rule conflicts. A
deeper applied file can override an earlier file, but Foundation does not claim
which individual sentence wins.

## Configuration

```yaml
schemaVersion: 1
instructions:
  canonical: AGENTS.md
  claude: CLAUDE.md
  gemini: GEMINI.md
  copilot: .github/copilot-instructions.md
scripts:
  changed: check:changed
  fast: check:fast
  full: check
changedChecks:
  - id: lint
    script: lint:fast:files
    extensions: [.js, .ts, .tsx]
  - id: typecheck
    script: typecheck
    extensions: [.ts, .tsx]
    passPaths: false
fullScanPaths:
  - .github/workflows
  - pnpm-lock.yaml
```

`passPaths: false` runs a project-wide script when any matching file changes.
Foundation always treats the instruction files, `foundation.config.yaml`, this
capability's config, and `package.json` as control paths; consumers do not repeat
them in `fullScanPaths`.
Invoke the changed workflow through the configured pnpm package script. This
also supplies the cross-platform pnpm entrypoint without invoking a shell or
interpolating repository paths.
Version 1 deliberately uses pnpm scripts. Another package manager requires a
qualified execution adapter rather than consumer-side duplication.

## Repository boundary

The implementation and behavior tests belong in Engineering Foundation.
Consumer `.github/` directories contain only the Copilot pointer and normal CI
workflow. Putting the engine in a shared `.github` repository would cover GitHub
Actions but would not provide a local command to Codex, Claude, OpenCode, Gemini,
developers, or self-hosted environments.
