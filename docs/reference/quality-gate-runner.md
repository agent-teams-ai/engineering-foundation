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

## Lifecycle and evidence

SIGINT and SIGTERM stop new scheduling and cancel active process-containment
boundaries. POSIX uses process groups and Windows uses the existing Job Object
adapter. The same portable containment limitation documented for local mode
applies when an adversarial descendant deliberately escapes its process group.

JSON is the canonical `quality-gate-run-report/v1` evidence. It records profile
outcome, monotonic duration, declaration-ordered tasks, task outcome, duration,
exact observed exit code and signal, and at most the final 8192 characters of
combined failure output. Successful task output is not retained. Text is a
rendering of the same report.

The command returns 0 on success, the first declaration-ordered failed task's
non-zero exit code, 124 for a timeout when no earlier failed task determines the
result, 130 for SIGINT, and 143 for SIGTERM. Invalid input uses the Foundation
CLI's stable exit code 2. Independent tasks continue after another task fails;
only `needs` edges block downstream work.

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
6. retain the versioned JSON report as evidence when machine consumption is
   required.

Foundation does not infer profiles, edit consumer scripts, activate the
capability during upgrade, or claim that static validation proves scripts passed.
