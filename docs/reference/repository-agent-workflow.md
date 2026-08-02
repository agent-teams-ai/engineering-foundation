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

Changed-file checks are an optimization only. A passing result never replaces
the complete `check` command in required CI. Hooks may call the same script for
convenience, but hooks are optional because agents and users can bypass them.

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
