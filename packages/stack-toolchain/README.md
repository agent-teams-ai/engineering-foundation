# Stack Toolchain

One versioned development dependency for TypeScript checking, linting,
format checking and compilation in ordinary Node and Bun projects.

The CLI runs on supported Node.js 24 (24.18.0 or newer) and Node.js 26.
Bun is an installed checker fallback, not the CLI host runtime.

## When to use it

Use Stack Toolchain when several projects repeat compiler and linter versions,
technical presets and package scripts. A released toolchain version fixes that
set together, so consumers can upgrade one dependency and their lockfile.
Projects retain their own source paths, tsconfig, environment types, output
locations, tests and product policies.

The package is intended for independent projects. It does not require
Engineering Foundation, organization credentials, a module architecture or
organization governance. Its source repository does not restrict its users.

The initial profiles are `typescript-node` and `typescript-bun`. Additional
profiles require a real consumer. Unrelated language toolchains belong in
separate packages rather than mandatory dependencies of every installation.

## Commands

| Command                    | Responsibility                                                  |
| -------------------------- | --------------------------------------------------------------- |
| `typecheck`                | Read-only checking of configured standalone TypeScript projects |
| `lint`                     | Run the pinned linter and selected technical preset             |
| `format:check`             | Check formatting without changing files                         |
| `compile --project <path>` | Compile with the pinned official TypeScript compiler            |
| `compile --build <path>`   | Build a TypeScript reference graph explicitly                   |
| `doctor`                   | Explain profile, tool versions and executable availability      |

`doctor --json` requires no consumer configuration and never installs or repairs
tools. Its existing outer `schemaVersion: 1` report contains doctor details with
`schemaVersion: 1`, the actual installed `packageVersion`, and a flat entry for
each tool in the exported `toolchain-manifest.json`. Each entry reports
`expectedVersion`, `installedVersion`, `resolvedVersion`, `required`, `available`
and `versionSource`; executed probes retain their raw `version` and `stderr`.
The typed companion has no supported version command: its installed package and
native package versions and executable permission are checked without launching
its unsupported CLI, and `versionSource` is `installed-package`.

Doctor exits 2 for required absence (`TOOLCHAIN_TOOL_UNAVAILABLE`), installed or
reported pin mismatch (`TOOLCHAIN_TOOL_PIN_MISMATCH`), or an unsuccessful or
unrecognized version probe (`TOOLCHAIN_TOOL_PROBE_FAILED`). Findings name the
tool and their `error` or `info` severity; failed executable resolution also
retains a bounded `resolutionCode`. Normal optional tsrs/Bun absence produces
`TOOLCHAIN_OPTIONAL_TOOL_UNAVAILABLE` information and permits exit 0. Typecheck
keeps its existing sequential fallback; doctor does not select a checker or
replace the consumer's qualification and dependency policies.

Installed dependency resolution checks physical package, executable, wrapper and
native binding paths against the installation's `node_modules` boundary.
Contained `.pnpm` and `.bun` stores and hardlinked files remain supported;
symlinks escaping that boundary reject before execution. Explicit source
development retains its existing external dependency layout and does not prove
the containment of an installed or registry-qualified package.

## Type checking and fallback

Optional tsrs and Bun binaries without execution permission are reported as unavailable; lifecycle scripts are never enabled to repair them.

The normal route starts only tsrs. Success ends the command. A classified
engine failure or unavailable executable permits Bun check; its success ends
the command. Only failure or unavailability of both engines permits the pinned
official TypeScript 7.0.2 checker. The three engines do not run together.

Source diagnostics, invalid project configuration, cancellation, incomplete
output capture, uncertain cleanup and unknown failure formats stop the command.
A different compiler must never turn a known project error into success.
Fallback restarts the complete project group and reports the actual engine and
reason. It shares the original deadline instead of resetting the budget.

The pinned tsrs `0.18.0-ts7.1.0-dev.20260929` implements a TypeScript 7.1
development revision; Bun 1.4.3 and the official fallback use TypeScript 7.0.2.
Qualification checks a defined corpus; it cannot prove complete language
equivalence or detect every newer feature after success.

The first read-only profile rejects project references explicitly, including
reference-only roots. Effective `noCheck: true` is also rejected. Standalone
composite projects retain their compiler constraints with incremental metadata
directed to the operating system null device. Existing reference-graph build
gates remain required.
Compilation is a separate operation; typecheck does not produce declarations,
JavaScript or incremental state, or silently build prerequisites.

## Ownership and delivery

Stack Toolchain owns exact tool versions, presets, executable resolution and
result classification. It uses the published node-or-bun process mechanism.
Consumers own checked scope and technical environment; Foundation may compose
the commands into its existing quality gates without becoming a prerequisite.

When syntax and typed lint cover different files, add an optional `lint.syntax`
scope with its own `config` and nonempty `paths`. The existing `lint.config` and
`lint.paths` remain the typed scope; configurations without `syntax` retain one
typed invocation. For example:

```json
{
  "lint": {
    "config": ".oxlintrc.type-aware.json",
    "paths": ["src"],
    "syntax": {
      "config": ".oxlintrc.json",
      "paths": ["src", "scripts", "tests"]
    }
  }
}
```

Both configurations are validated before execution. Syntax runs first and stops
the command on failure. Only syntax success starts typed lint and resolves its
typed companion. The lanes share the original cancellation signal and deadline;
multi-lane reports name each executed lane. Syntax configuration and its inherited
presets must not enable `typeAware` or `typeCheck`. No linter failure triggers a
checker fallback. Consumers declare and enforce their production census and
checked paths; the toolchain does not infer product ownership from directories.
Type checking and formatting keep their independently configured scopes.

### Experimental Bun lint

Oxlint 1.90.0 with oxlint-tsgolint 7.0.2005 remains the default linter.
Bun stable 1.4.4 does not provide `bun lint`; the current Bun lint documentation
describes a canary capability. This opt-in backend requires a separate consumer
development alias, without changing the toolchain's Bun typecheck pin:

```sh
npm install --ignore-scripts --save-dev --save-exact bun-lint@npm:bun@1.4.4-canary.20261028.1
```

Set `lint.backend` to `"bun-experimental"` in `toolchain.config.json`.
Omitting it, or selecting `"oxlint"`, uses Oxlint. The alias must be in the
consumer root's `devDependencies` only. Stack checks its exact declared coordinate,
the wrapper and native package versions, installation containment and the actual
`1.4.4-canary.1+11c367163` binary revision before linting. It never installs or
repairs the alias. The npm archive's wrapper and native manifests include
`+11c3671` build metadata in their version. The child command uses `--no-script`,
so a consumer's `lint` script cannot replace the linter.

The command supplies a private empty TOML file through Bun's global `--config`
before `lint`. Project and ancestor bunfig files cannot add plugins, change rules,
ignore source or allow unsupported rules. The temporary file is private to this
invocation and is removed after execution settles. JSON inheritance follows each
config's lexical path, including file symlinks; validation caches separate lexical
contexts and retains canonical cycle and target-extension checks.

Both lanes retain the configured paths, config inheritance, deadline, cancellation
and raw output. Details identify the experimental backend and revision. Ordinary
diagnostics exit 1; unsupported configuration or execution exits 2, with the
original child result retained. No failure starts another linter.

This is an experimental profile, not general Oxlint equivalence. The upstream
[migration guide](https://bun.sh/guides/lint/migrate-from-oxlint) documents
control-flow and parser differences; the qualified corpus does not establish
complete equivalence. Keep independent TypeScript checking. Vue and JSDoc
plugins/rules, override extglobs and rule-option fields
named for patterns or regular expressions reject before execution. Rule options
containing strings other than severity names also reject, including positional
regular expressions; prefer the default backend for those configurations. JavaScript
plugins remain prohibited. Other unsupported rules fail through Bun; Stack never
passes `--allow-unsupported`. Bun uses JavaScript rather than Rust regular
expressions, so option shapes outside those rejecting guards require explicit
consumer qualification. This profile does not qualify arbitrary custom configs,
Vue files, editor language-server support, or all diagnostic wording.

Backend dispatch stays inside the existing toolchain-execution adapter, using
the same node-or-bun process owner. It adds no module graph or lifecycle owner.
An independent consumer's census, protected-rule and production-negative gates
remain required. Foundation's existing quality coverage producer still observes
Oxlint; selecting this experimental backend does not qualify Bun for that
capability or migrate its consumer profile.

Release qualification must cover positive and negative diagnostics, all
fallback routes, cancellation and cleanup, unchanged files during checks,
native platform support and clean installations with lifecycle scripts disabled.
Publication and consumer adoption are separate steps. No global executable or
on-demand download is a substitute for a qualified installed dependency.

### Technical presets

This package includes TypeScript and Oxlint presets,
retaining the existing Foundation settings and strictness. Foundation 2.x remains
the authority for its existing preset exports until the separately reviewed
consumer migration. New independent consumers may select these presets directly;
existing Foundation consumers migrate only with that later release.

TypeScript configurations extend `stack-toolchain/presets/typescript/node.json`
for Node or `stack-toolchain/presets/typescript/bun.json` for Bun. Both inherit
`typescript/base.json`; Bun uses bundler resolution and requires the consumer's
pinned `@types/bun` development dependency. The project owns its actual runtime
version, ambient type dependencies, source inclusion and output configuration.

Oxlint configurations extend the installed JSON file under
`./node_modules/stack-toolchain/presets/oxlint/`: `node.json` supplies the fast
Node rules and `type-aware.json` adds semantic lint rules with `typeCheck: false`.
The type-aware preset applies semantic rules to `.ts`, `.tsx`, `.mts` and `.cts`.
JavaScript (`.js`, `.jsx`, `.mjs` and `.cjs`) retains syntactic rules; this preset
does not qualify checked JavaScript. Its JavaScript exception covers the pinned
linter's complete typed-rule set and rejects unnoticed changes during upgrades.
Add `maintainability.json` for production budgets or
`maintainability-tests.json` for test budgets. These are portable technical
presets; product policy and organization conformance remain in their consumers.

## Minimal adoption

Install an exact released version as a development dependency. For version
`0.1.0`:

```sh
npm install --save-dev --save-exact stack-toolchain@0.1.0
```

A Node project can place this explicit `toolchain.config.json` beside its package
manifest (replace the paths with the consumer's actual source scope):

```json
{
  "schemaVersion": 1,
  "profile": "typescript-node",
  "typecheck": { "projects": ["tsconfig.json"] },
  "lint": { "config": ".oxlintrc.json", "paths": ["src"] },
  "format": { "paths": ["src"] }
}
```

Use JSON or JSONC for the linter configuration; JavaScript plugins and hidden
semantic `typeCheck` are rejected. Formatting uses the package's fixed JSON
preset, so consumer executable formatter configuration is never loaded.

Keep stable package scripts while upgrading the single pinned dependency:

```json
{
  "scripts": {
    "typecheck": "stack-toolchain typecheck",
    "lint": "stack-toolchain lint",
    "format:check": "stack-toolchain format:check",
    "compile": "stack-toolchain compile --project tsconfig.json"
  }
}
```

For Bun select `typescript-bun` and its TypeScript preset. The consumer supplies
its own exact Node or Bun ambient types, compiler environment and build outputs;
the toolchain does not infer or install product-specific environment types.
