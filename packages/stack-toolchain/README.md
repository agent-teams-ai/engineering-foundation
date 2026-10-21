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

| Command | Responsibility |
| --- | --- |
| `typecheck` | Read-only checking of configured standalone TypeScript projects |
| `lint` | Run the pinned linter and selected technical preset |
| `format:check` | Check formatting without changing files |
| `compile --project <path>` | Compile with the pinned official TypeScript compiler |
| `compile --build <path>` | Build a TypeScript reference graph explicitly |
| `doctor` | Explain profile, tool versions and executable availability |

## Type checking and fallback

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
