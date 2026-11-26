# Optional Effect diagnostics

The `stack-toolchain/effect` subpath and `effect:check` CLI check explicitly
selected standalone TypeScript projects with the pinned native Effect compiler.
Consumers opt into this development-time policy. Ordinary Stack checking keeps
its existing fallback and dependency installation behavior.

This source adds the contract. Use a released Stack package that exports
`stack-toolchain/effect`, or its built candidate archive during qualification.
An older package does not acquire the entry by installing the compiler.
Publication and production activation retain their own acceptance gates.

## Installation and host

Install the selected Stack artifact as an exact development dependency. On the
qualified Linux x64 diagnostic host, explicitly install its native companion:

```sh
npm install --save-dev --save-exact @effect/tsgo-linux-x64@0.73.4
```

Keep a real lockfile and use frozen installation. Stack does not download,
patch or repair tools at check time. The archive is about 130 MB compressed and
334 MB unpacked; its installation is explicit. Unsupported hosts reject before
native execution.

The companion contains the patched TypeScript 7.0.2 compiler. This route does
not load the `@effect/tsgo` JavaScript launcher or execute its embedded older
TypeScript dependency. The `@effect/language-service` string in the config below
names the native compiler's policy; it does not request JavaScript plugin loading.
Package/version, executable digest and all 108 paired standard-library files are
verified before checking.

The Linux restriction concerns the diagnostic executable. Effect application
code can target backend or frontend environments according to the application's
runtime qualification. Foundation and Stack remain engineering dependencies,
outside production runtime code.

## Explicit leaf policy

Each selected leaf JSON/JSONC project declares its Effect policy directly.
For example, a portable SDK can use:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024", "ESNext.Disposable", "ESNext.Promise", "DOM"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": false,
    "types": [],
    "plugins": [
      {
        "name": "@effect/language-service",
        "diagnostics": true,
        "includeSuggestionsInTsc": false,
        "ignoreEffectWarningsInTscExitCode": false,
        "ignoreEffectErrorsInTscExitCode": false,
        "diagnosticSeverity": {
          "unstableApiUsage": "error",
          "apiStabilityLeak": "error"
        },
        "allowedUnstableApis": []
      }
    ]
  },
  "files": ["src/index.ts"]
}
```

The selected project is a flat standalone JSON/JSONC config: `extends` is not
supported in this initial profile. The native compiler merges inherited Effect
file overrides, and its `--showConfig` output omits them. An explicit leaf policy
cannot reset that hidden inherited state. Rejecting inheritance makes activation
reviewable without a second TypeScript config resolver. Ordinary Stack typecheck
retains its existing config inheritance support.

Use separate selected SDK, backend-adapter and frontend projects when allowances
differ. An adapter can name an exact export such as
`effect/http/HttpClient#get` in its `allowedUnstableApis` array. Select the other
projects with their own policies too. The command proves declared scope; it does
not discover which projects your repository ought to check.

The first contract rejects file overrides, wildcard allowances, duplicate or
conflicting plugins, disabled diagnostics, weakened required severities and
ignored Effect errors. Effective strict-family options may not be disabled.
`noCheck`, `skipLibCheck` and project references are outside this strict
standalone profile. Reference-graph builds remain separate consumer gates.

`compilerOptions.generateTrace` is rejected before the first project probe.
Native tracing writes files even with `noEmit` and `--listFilesOnly`, so it is
outside this read-only diagnostic command. Run trace collection separately.

The effective `files`/`include` selection must cover every consumer-local
implementation source in the compiler's complete inventory, including imports
from adjacent local packages. Spell those roots through their canonical paths,
without file or directory symlink aliases. The native compiler can otherwise
classify a workspace package reached through `node_modules` as an external
library and skip its Effect rules. Explicit canonical roots prevent that skip.
An imported local file omitted from the effective roots rejects the project.

Consumer-local `.d.ts`, `.d.mts` and `.d.cts` files also reject, including when
imported by an implementation file. The pinned upstream Effect runner skips
declaration files, so this profile cannot certify their Effect policy. Check
the implementation sources that define the public contract. Installed dependency
declarations and paired standard libraries remain admitted for type resolution.

## CLI and API

Select every intended project explicitly:

```sh
npx --no-install stack-toolchain effect:check --json \
  --project tsconfig.sdk.json \
  --project tsconfig.backend.json \
  --project tsconfig.frontend.json
```

The typed entry uses the same implementation and a caller-owned cancellation
signal:

```ts
import { checkEffectProjects, effectDiagnosticsContractVersion } from "stack-toolchain/effect";

if (effectDiagnosticsContractVersion !== 1) {
  throw new Error("Unsupported Effect diagnostic contract");
}

const controller = new AbortController();
const report = await checkEffectProjects({
  cwd: process.cwd(),
  projects: ["tsconfig.sdk.json", "tsconfig.backend.json"],
  signal: controller.signal,
  budgetMs: 120_000,
});

process.exitCode = report.exitCode;
```

A failed report fails the selected gate. Ordinary `typecheck` success cannot
substitute for this check; no fallback compiler rescues a policy violation.

Reports retain selected projects, each observed complete local source inventory,
per-project results and unattempted projects. A successful subset cannot report
an overall pass. Diagnostic exit code 1 is distinct from invalid input or an
unavailable, incompatible or failed tool (2). Caller cancellation returns 130;
the CLI also retains its normal signal exit behavior.

Inputs, reads, output and the total budget have runtime limits. Version/config/
source-list probes and semantic checks share that budget. All subprocesses use
the existing node-or-bun owner. Incomplete capture, uncertain cleanup, crashes
and unknown output cannot become expected source diagnostics or success.

The initial limits are 64 selected projects, 50,000 compiler-listed files per
project, a 1 MiB leaf config, 4 MiB per local source file and 256 MiB of local
source bytes per project. The default total budget is five minutes; callers can
set a positive integer up to 2,147,483,647 milliseconds. These are defensive
execution limits, not measured application-size or latency guarantees.

Output classification supports the qualified English TypeScript message-chain
families, with two-space indentation, at most 32 levels, 128 continuations per
primary diagnostic and 8,192 characters per line. Other message shapes remain
visible in raw output and fail as an execution error. The checker therefore
fails conservatively if an unfamiliar diagnostic format is encountered.

## Stable boundaries and exceptions

`unstableApiUsage` diagnoses use of an unstable export. A bare unused import is
not equivalent to using it. `apiStabilityLeak` inspects exported type surfaces;
the pinned upstream rule treats an untagged export as stable. An explicit
`@stability stable` annotation documents that intent but is not required to
activate the check. This follows the pinned
[export walker](https://github.com/Effect-TS/tsgo/blob/aa2db44499067a798028cff9d3b1b9ca1e156f57/internal/rules/api_stability_leak.go)
and [stability defaults](https://github.com/Effect-TS/tsgo/blob/aa2db44499067a798028cff9d3b1b9ca1e156f57/internal/typeparser/api_stability.go).
The rule does not infer every package's public contract from its exports map,
and its bounded type analysis is not an independent proof that every possible
TypeScript type surface is free of leaks.

A consumer-owned structural port keeps adapter implementation types out of the
public contract:

```ts
/** @stability stable */
export interface DocumentSummary {
  readonly title: string;
  readonly revision: number;
}
```

Keep unstable implementation types inside the adapter and expose the stable
owned shape at the boundary. Allowing `effect/http/HttpClient#get` permits that
use; it does not permit a stable export to expose the returned unstable HTTP
types. Map those types to the consumer-owned contract at the adapter boundary.
An exact use allowance does not replace package exports, source-dependency
checks, runtime tests or review of that boundary.

This strict profile permits exceptions through explicit project policy.
Consumer source containing the reserved `@effect-diagnostics` token rejects,
including local files imported by the selected project. The case-insensitive
`@ts-nocheck` token also rejects because it prevents the compiler from running
Effect rules for the file. These lexical rules deliberately reject token text
inside strings too. This conservative restriction closes upstream suppressions
without another directive parser. Installed third-party declarations are outside
consumer suppression policy. Ordinary `@ts-ignore`/`@ts-expect-error` retain their
TypeScript meaning; the pinned Effect compiler excludes its own diagnostic codes
from those directives.

## Accepted and rejected usage

| Usage                                                                                 | Behavior                                                                             |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Stable Effect use with explicit strict policy                                         | Checks with the selected native compiler                                             |
| Ordinary TypeScript error                                                             | Fails as a diagnostic; no Effect-only filter hides it                                |
| Used unstable export without an exact allowance                                       | Fails the required policy                                                            |
| Annotated stable signature leaking an unstable type                                   | Fails the stable-surface rule                                                        |
| Exact allowance in a selected adapter project                                         | Applies to that check; other selected projects retain their own policy               |
| Missing/weakened policy or source directive                                           | Rejects activation                                                                   |
| Consumer-local declaration source                                                     | Rejects because the native Effect rules do not inspect it                            |
| Imported local source omitted from effective roots, or a symlink alias used as a root | Rejects to preserve native Effect rule coverage                                      |
| Selected config containing `extends`                                                  | Rejects because inherited Effect overrides cannot be independently observed or reset |
| Missing/wrong compiler or replaced paired library                                     | Rejects before semantic checking                                                     |
| Consumer source/config escaping the declared root                                     | Rejects; installed declarations have a separate physical installation boundary       |
| Cancelled, timed-out or incompletely captured process                                 | Fails without a successful partial result                                            |
| Ordinary Stack use without Effect installed                                           | Keeps the existing command and dependency behavior                                   |

Checks force no emission and redirect incremental build information to the OS
null device. They never enter build/watch mode or accept arbitrary compiler
flags. Source ownership is cooperative; this is not isolation from hostile
concurrent filesystem changes. The compiler supplies the complete source list,
so Stack adds no import resolver or independent tsconfig inheritance-chain audit.

## Qualification and upgrades

The [integration plan](https://github.com/agent-teams-ai/engineering-foundation/blob/main/docs/research/effect-diagnostics-integration-2026-11-25.md)
tracks review receipts and delivery evidence. The retained
[native pilot](https://github.com/agent-teams-ai/engineering-research/tree/c99f19835ca3e80c5a7268f8bf42f089418e1cf0/evidence/experiments/effect-diagnostics-2026-11-24)
provides the initial compiler identity, diagnostic controls and paired-library
comparison. The installed integration qualifies its own published cohort:
Core/Assembly 0.8.0, GM Effect 0.1.1 and its exact Effect 4.1.4 peer.

Disposable SDK/backend/frontend-shaped consumers establish the bounded technical
contract before products exist. Their portable types do not constitute browser
execution or product adoption. The N100 observation reuses the unchanged
Promise-based GM generator: 703 source files, identical inputs for stock and
Effect-native TypeScript 7.0.2, and a separate policy canary. It measures compiler
cost, without a native Effect runtime-scale or production-capacity claim.

A companion upgrade requires new exact artifact/library identity and renewed
qualification of activation, diagnostics, source inventory, cancellation,
read-only behavior and installed entrypoints. The consumer chooses whether to
adopt this policy. Once selected, a missing or failed check fails its gate.
