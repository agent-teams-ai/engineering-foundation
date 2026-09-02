# Quality Gate Runner

Status: Implemented and dogfooded after the Foundation build. Consumer adoption
remains explicit and requires a released package version.

`quality.gate-runner` composes existing root `package.json` scripts into named,
deterministic profiles. It is a bounded quality-gate mechanism, not an agent
orchestrator, task provisioning system, generic shell runner, or replacement for
the consumer's CI service.

## Activation and command

Installation or upgrade does not activate the runner. A consumer must declare
the capability in `foundation.config.yaml` and add its own capability file:

```yaml
capabilities:
  quality.gate-runner:
    configPath: architecture/foundation/quality-gates.yaml
```

After the package is installed and the consumer is otherwise ready, run one
profile explicitly:

```bash
agent-teams-foundation gate run fast --consumer .
agent-teams-foundation gate run fast --consumer . --format json
```

`foundation check` validates the declaration, graph, script existence, and
recursion policy. It never executes a package script.

For declaration, graph, script-existence, or statically recognized recursion
failures, run `agent-teams-foundation check quality.gate-runner --consumer .`
and correct the reported declaration or consumer-owned script. The check is
static; it cannot diagnose an execution-only failure.

For `QUALITY_GATE_PROFILE_UNKNOWN`, select a profile ID declared in the file at
`capabilities.quality.gate-runner.configPath` in `foundation.config.yaml` (or
deliberately add the missing profile) and rerun `gate run` with that ID. The
`architecture/foundation/quality-gates.yaml` path above is only an example. For
active `QUALITY_GATE_RECURSION`, stop the nested `gate run`, remove that launch from the
executing wrapper or package script, and rerun only the outer profile. Neither
case requires a static check before applying its direct correction.

## Configuration

```yaml
schemaVersion: 1
packageManager: pnpm
profiles:
  - id: fast
    concurrency: 3
    tasks:
      - id: lint
        timeoutMs: 300000
      - id: typecheck
      - id: test
        needs: [lint]
        after: [typecheck]
```

Every task `id` is both its graph identity and an allowlisted existing root
`package.json` script ID. Configuration cannot provide commands, arguments,
executables, environment variables, working directories, or plugins. The Node
adapter invokes exactly `pnpm run <id>` without a shell at the process boundary.

- `needs` waits for the referenced tasks and runs only if all passed. Otherwise
  the task is `blocked`.
- `after` waits for the referenced tasks to settle regardless of outcome.
- dependencies are the union of `needs` and `after`; the union must be a DAG.
- ready tasks start in their declaration order, up to `concurrency`.
- `timeoutMs` applies to one task and its retained descendant process tree.

Profiles, tasks, and dependencies must be unique and known. Self-dependencies,
cycles, overlap between `needs` and `after`, unsafe script IDs, missing scripts,
direct runner recursion, recognized indirect package-script recursion, invalid
concurrency, and invalid timeouts fail before execution.

Static script inspection is intentionally conservative rather than a shell
parser. An inherited runtime marker also rejects recursion assembled dynamically
by a wrapper script, so an unrecognized command shape fails instead of creating
an unbounded tree of nested runners. The CLI takes one immutable snapshot of the
provided environment, adds the recursion marker to that snapshot, and passes the
exact snapshot through the pnpm adapter to every task. It neither mutates the
caller's environment nor re-reads ambient environment state during the run.

## Lifecycle and evidence

SIGINT and SIGTERM stop new scheduling and cancel active process-containment
boundaries. POSIX uses process groups and Windows uses the existing Job Object
adapter. The same portable containment limitation documented for local mode
applies when an adversarial descendant deliberately escapes its process group.
The CLI subscribes once before loading `foundation.config.yaml`, retains the
first SIGINT or SIGTERM until the command finishes, and passes the same
`AbortSignal` through Foundation configuration, QGR policy and script-catalog
loading, and task execution. SIGINT exits 130 and SIGTERM exits 143. If a real
task, output-limit, or containment failure is observed while cancellation is in
progress, the task and aggregate report remain failed and the failure exit code
takes precedence over the cancellation exit code.

Managed-process deadlines reject with the typed `ProcessTimeoutError`, whose
`timeoutMs` property retains the configured value. The pnpm adapter classifies
timeouts with `instanceof` and translates them to `PackageScriptTimeoutError`;
it does not infer timeout semantics by matching error-message text.

The QGR lifecycle capability qualification runs in cross-platform test shard 3.
The required `macos-qualification` adapter-qualification lane also runs the
focused QGR lifecycle suite
after building, so Darwin proves the same entrypoint cancellation and POSIX
containment behavior rather than relying on Linux evidence. The suite observes
cooperating, harness-owned fixture roles. Its fixture server assigns a distinct
one-use credential to each declared role; a registration presents that
credential and the server, not the client, resolves the role. A deterministic
port test proves that the configured `timeoutMs` crosses the command, use-case,
pnpm adapter, and managed-process
request unchanged; controlled application evidence proves timeout classification
and concurrent-sibling isolation without a wall-clock gate. One cross-platform
cancellation capability qualification waits for authenticated readiness, then drives the
QGR cancellation port through the real installed pnpm process boundary. On
Windows that reaches the Job Object adapter without relying on POSIX signals.
The installed-pnpm and synthetic cancellation evidence requires every owned role
connection to close before accepting final command completion.

This is exact evidence for the owned fixture model, not hostile-process
authentication. The credentials prevent one inherited fixture bearer from
selecting arbitrary roles, but they do not attest an operating-system process
identity, PID ancestry, or resistance to a hostile process that can read or
modify the fixture's files, arguments, memory, or inherited environment. The
production containment boundary and its documented escaped-descendant
limitation remain the security boundary; fixture sockets are test evidence only.

JSON is the canonical `quality-gate-run-report/v1` evidence. It records profile
outcome, monotonic duration, declaration-ordered tasks, task outcome, duration,
exact observed exit code and signal, and at most the final 8192 characters of
combined failure output. Unsafe terminal control characters are escaped before
the evidence is retained or rendered. Successful task output is not retained.
Text is a rendering of the same report. A task whose exit 0 was already observed
remains `passed` with exit code 0 when cancellation is observed immediately
afterward, while the aggregate run remains `cancelled`. Cancellation during
Foundation configuration, QGR policy, or script-catalog loading emits one
canonical `foundation-command-error/v1` cancellation envelope in JSON mode
because no run report exists yet. Text mode writes one concise cancellation
message instead. A non-cancellation setup failure observed after a signal is not
reclassified as cancellation.

`createQualityGateCliCommand` owns the single CLI projection. JSON and text use
the canonical report renderer; there is no secondary execution-and-rendering
entrypoint with independent exit-code logic.

Canonical QGR JSON is execution evidence, not standalone provenance. A consumer
that retains it must wrap it in external evidence binding the consumer identity,
repository revision, and configuration digest. Those bindings remain outside
the current report schema.

The command returns 0 on success, the first declaration-ordered failed task's
non-zero exit code, 124 for a timeout when no earlier failed task determines the
result, 130 for SIGINT, and 143 for SIGTERM. A task or containment failure takes
precedence over cancellation. Invalid input uses the Foundation CLI's stable
exit code 2. Independent tasks continue after another task fails; only `needs`
edges block downstream work.

## Adoption contract

An Orchestrator or Platform consumer should adopt only after the exact
Foundation release is available from the registry. Its adoption change must:

1. keep Foundation as an exact development dependency and restore registry mode;
2. declare `quality.gate-runner` explicitly and keep all task IDs consumer-owned;
3. map only existing deterministic package scripts, with timeouts based on real
   gate budgets and bounded concurrency appropriate to the host;
4. prove positive order/concurrency behavior plus failure, timeout, and
   cancellation behavior in an isolated test consumer;
5. add the selected profile command to consumer CI without removing independent
   required security, release, or full-suite gates;
6. retain the versioned JSON report inside a consumer, repository-revision, and
   configuration-digest evidence envelope when machine consumption is required.

Foundation does not infer profiles, edit consumer scripts, activate the
capability during upgrade, or claim that static validation proves scripts passed.
