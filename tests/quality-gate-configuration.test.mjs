import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertFeatureOutsideSchemaCycles,
  assertSchemaAssemblyImportRejected,
} from "./helpers/schema-assembly-boundaries.mjs";
import { loadQualityGatePolicy } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/inbound/configuration/load-quality-gate-policy.js";
import { parseQualityGatePolicy } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/inbound/configuration/parse-quality-gate-policy.js";
import { CapabilityInputError } from "../packages/engineering-foundation/dist/features/validation-reporting/api.js";
import { assertSchema as assertFoundationSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";
import { BunQualityGateScriptExecutor } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/outbound/bun/bun-package-script-executor.js";
import { createPackageManagerScriptExecutor } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/composition/select-package-script-executor.js";
import { resolveRepositoryRuntimeExecutables } from "../packages/engineering-foundation/dist/process-execution/application/runtime-selection.js";
import { RecordingManagedProcessExecutor } from "./support/quality-gate-runtime-adapters.mts";
import { resolveQualificationExecutables } from "../tools/executable-policy.mts";
import { resolvePnpmInvocation } from "../tools/pnpm-command.mts";
import { readRepositoryRuntimePolicy } from "../tools/runtime-policy.mts";

test("quality gate configuration no longer joins the module schema assembly cycle", async () => {
  await assertFeatureOutsideSchemaCycles("quality-gate-runner");
});

test("source policy rejects reintroducing schema assembly inside the quality gate adapter", async () => {
  await assertSchemaAssemblyImportRejected(
    "packages/engineering-foundation/src/capabilities/quality-gate-runner/adapters/inbound/configuration/load-quality-gate-policy.ts",
    "../../../../../schema-catalog.js",
  );
});

test("quality gate configuration retains the dependency trace and immutable task graph", async () => {
  const input = {
    schemaVersion: 1,
    packageManager: "pnpm",
    profiles: [
      {
        id: "verify",
        concurrency: 2,
        tasks: [{ id: "build" }, { id: "test", needs: ["build"], timeoutMs: 5000 }],
      },
    ],
  };
  const calls = [],
    signal = new AbortController().signal;
  const policy = await loadQualityGatePolicy(
    {
      async readYaml(...args) {
        calls.push(["read", ...args]);
        return input;
      },
      async assertSchema(...args) {
        calls.push(["schema", ...args]);
      },
    },
    "explicit-memory-consumer",
    "quality-gates.yaml",
    signal,
  );
  assert.deepEqual(calls, [
    [
      "read",
      "explicit-memory-consumer",
      "quality-gates.yaml",
      "quality-gate-runner-config",
      signal,
    ],
    ["schema", "quality-gate-runner/v1", input, "quality-gate-runner-config"],
  ]);
  assert.deepEqual(policy, {
    profiles: [
      {
        id: "verify",
        packageManager: "pnpm",
        concurrency: 2,
        tasks: [
          { id: "build", needs: [], after: [] },
          { id: "test", needs: ["build"], after: [], timeoutMs: 5000 },
        ],
      },
    ],
  });
  assert.deepEqual(parseQualityGatePolicy(input), policy);
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.profiles[0].tasks));
  assert.ok(Object.isFrozen(policy.profiles[0].tasks[1].needs));
});

test("v1 typed custom policy loaders retain the root pnpm contract", () => {
  const fixture = fileURLToPath(
    new URL("./fixtures/quality-gate-v1-consumer/tsconfig.json", import.meta.url),
  );
  const compiler = join(
    fileURLToPath(new URL("..", import.meta.url)),
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );
  const result = spawnSync(process.execPath, [compiler, "--project", fixture], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("real Bun and pnpm managers preserve their selected ordinary leaf runtime", async () => {
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const cli = join(repositoryRoot, "packages/engineering-foundation/dist/cli.js");
  const dispatcher = join(repositoryRoot, "tools/repository-command.mts");
  const runtime = await resolveQualificationExecutables("bun");
  const { node, bun } = runtime;
  assert.ok(bun);
  const nodeVersion = spawnSync(node, ["-p", "process.versions.node"], {
    encoding: "utf8",
  }).stdout.trim();
  const policy = await readRepositoryRuntimePolicy();
  const manager = await resolvePnpmInvocation(node, policy.toolchain.pnpm.version);
  const pnpm = manager.kind === "javascript" ? manager.args[0] : manager.command;
  assert.ok(pnpm);
  const root = await mkdtemp(join(tmpdir(), "foundation-runtime-profiles-"));
  const bunRoot = join(root, "bun");
  const nodeRoot = join(root, "node");
  const observation = join(root, "observation.ndjson");
  try {
    const writeFixture = async (fixtureRoot, packageManager) => {
      await mkdir(join(fixtureRoot, "architecture/foundation"), { recursive: true });
      await writeFile(
        join(fixtureRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "runtime-profile-fixture",
            private: true,
            type: "module",
            packageManager,
            scripts: {
              "check:fast": `node ${JSON.stringify(dispatcher)} tool runtime-observe`,
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(join(fixtureRoot, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
      await writeFile(
        join(fixtureRoot, "foundation.config.yaml"),
        `schemaVersion: 1
project:
  id: runtime-profile-fixture
capabilities:
  quality.gate-runner:
    configPath: architecture/foundation/quality-gate-runner.yaml
`,
        "utf8",
      );
      await writeFile(
        join(fixtureRoot, "architecture/foundation/quality-gate-runner.yaml"),
        `schemaVersion: 2
profiles:
  - id: bun-check-fast
    packageManager: bun
    concurrency: 1
    tasks: [{ id: check:fast }]
  - id: node-check-fast
    packageManager: pnpm
    concurrency: 1
    tasks: [{ id: check:fast }]
`,
        "utf8",
      );
    };
    await writeFixture(bunRoot, "bun@1.4.3");
    await writeFixture(nodeRoot, "pnpm@11.20.0");
    // Each CLI establishes its own runtime profile, independent of the outer gate.
    const environment = Object.fromEntries(
      Object.entries({
        ...process.env,
        AGENT_TEAMS_FOUNDATION_RUNTIME_OBSERVATION: observation,
        AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: node,
        AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: bun,
        AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT: pnpm,
      }).filter(
        ([name]) =>
          !["npm_config_user_agent", "agent_teams_foundation_runtime_profile"].includes(
            name.toLowerCase(),
          ),
      ),
    );
    const bunRun = spawnSync(
      bun,
      [cli, "gate", "run", "bun-check-fast", "--consumer", bunRoot, "--format", "json"],
      {
        cwd: bunRoot,
        encoding: "utf8",
        env: environment,
      },
    );
    assert.equal(bunRun.status, 0, bunRun.error?.message ?? `${bunRun.stdout}${bunRun.stderr}`);
    const nodeRun = spawnSync(
      node,
      [cli, "gate", "run", "node-check-fast", "--consumer", nodeRoot, "--format", "json"],
      {
        cwd: nodeRoot,
        encoding: "utf8",
        env: { ...environment, npm_execpath: pnpm },
      },
    );
    assert.equal(nodeRun.status, 0, nodeRun.error?.message ?? `${nodeRun.stdout}${nodeRun.stderr}`);
    const observations = (await readFile(observation, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(observations.length, 2);
    assert.match(observations[0].managerUserAgent, /^bun\/1\.4\.3/u);
    assert.equal(observations[0].profile, "bun");
    assert.equal(observations[0].leafBunVersion, "1.4.3");
    assert.match(observations[1].managerUserAgent, /^pnpm\/11\.20\.0/u);
    assert.equal(observations[1].profile, "node");
    assert.equal(observations[1].leafBunVersion, null);
    assert.equal(observations[1].leafNodeVersion, nodeVersion);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public Node 24 constructs the CLI and executes a real pnpm QGR profile", async () => {
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const node = process.env["AGENT_TEAMS_FOUNDATION_PUBLIC_NODE24_EXECUTABLE"];
  if (node === undefined) {
    return;
  }
  const cli = join(repositoryRoot, "packages/engineering-foundation/dist/cli.js");
  const harness = join(repositoryRoot, "tests/support/record-repository-runtime.mts");
  const policy = await readRepositoryRuntimePolicy();
  const manager = await resolvePnpmInvocation(node, policy.toolchain.pnpm.version);
  const pnpm = manager.kind === "javascript" ? manager.args[0] : manager.command;
  assert.ok(pnpm);
  const root = await mkdtemp(join(tmpdir(), "foundation-public-node24-"));
  const observation = join(root, "observation.ndjson");
  try {
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "public-node24-qgr-fixture",
          private: true,
          type: "module",
          packageManager: "pnpm@11.20.0",
          scripts: { "check:fast": `node ${JSON.stringify(harness)}` },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
    await writeFile(join(root, ".npmrc"), "verify-deps-before-run=false\n", "utf8");
    await writeFile(
      join(root, "foundation.config.yaml"),
      `schemaVersion: 1
project:
  id: public-node24-qgr-fixture
capabilities:
  quality.gate-runner:
    configPath: architecture/foundation/quality-gate-runner.yaml
`,
      "utf8",
    );
    await mkdir(join(root, "architecture/foundation"), { recursive: true });
    await writeFile(
      join(root, "architecture/foundation/quality-gate-runner.yaml"),
      `schemaVersion: 2
profiles:
  - id: public-node24
    packageManager: pnpm
    concurrency: 1
    tasks: [{ id: check:fast }]
`,
      "utf8",
    );
    const environment = {
      ...process.env,
      PATH: `${join(node, "..")}:${process.env["PATH"] ?? ""}`,
      AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: node,
      AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT: pnpm,
      AGENT_TEAMS_FOUNDATION_RUNTIME_OBSERVATION: observation,
      npm_execpath: pnpm,
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
    };
    const result = spawnSync(
      node,
      [cli, "gate", "run", "public-node24", "--consumer", root, "--format", "json"],
      { cwd: root, encoding: "utf8", env: environment },
    );
    assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}${result.stderr}`);
    const observed = JSON.parse((await readFile(observation, "utf8")).trim());
    assert.equal(observed.leafNodeVersion, "24.18.0");
    assert.match(observed.managerUserAgent, /^pnpm\/11\.20\.0/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Catches v1 configurations silently gaining a profile-manager requirement.
test("quality gate v1 normalizes its root pnpm manager onto each internal profile", () => {
  const parsed = parseQualityGatePolicy({
    schemaVersion: 1,
    packageManager: "pnpm",
    profiles: [{ id: "bun-shaped", concurrency: 1, tasks: [{ id: "build" }] }],
  });
  assert.deepEqual(
    parsed.profiles.map(({ packageManager }) => packageManager),
    ["pnpm"],
  );
});

// Catches v2 profiles being forced through one manager or the legacy root field.
test("quality gate v2 selects bun or pnpm independently per named profile", async () => {
  const input = {
    schemaVersion: 2,
    profiles: [
      {
        id: "bun-check-fast",
        packageManager: "bun",
        concurrency: 1,
        tasks: [{ id: "check:fast" }],
      },
      {
        id: "node-check-fast",
        packageManager: "pnpm",
        concurrency: 1,
        tasks: [{ id: "check:fast" }],
      },
    ],
  };
  const calls = [];
  const parsed = await loadQualityGatePolicy(
    {
      async readYaml() {
        return input;
      },
      async assertSchema(...args) {
        calls.push(args);
        await assertFoundationSchema(...args);
      },
    },
    "explicit-memory-consumer",
    "quality-gates-v2.yaml",
  );
  assert.deepEqual(
    calls.map(([id]) => id),
    ["quality-gate-runner/v2"],
  );
  assert.deepEqual(
    parsed.profiles.map(({ id, packageManager }) => [id, packageManager]),
    [
      ["bun-check-fast", "bun"],
      ["node-check-fast", "pnpm"],
    ],
  );
});

// Catches v2 silently falling back to the v1 root manager when a profile omits its own.
test("quality gate v2 rejects a profile without an explicit manager", async () => {
  await assert.rejects(
    loadQualityGatePolicy(
      {
        async readYaml() {
          return {
            schemaVersion: 2,
            profiles: [{ id: "bun-check-fast", concurrency: 1, tasks: [{ id: "check:fast" }] }],
          };
        },
        assertSchema: assertFoundationSchema,
      },
      "explicit-memory-consumer",
      "quality-gates-v2.yaml",
    ),
    (error) => {
      assert.match(String(error), /packageManager/u);
      return true;
    },
  );
  assert.throws(
    () =>
      parseQualityGatePolicy({
        schemaVersion: 2,
        profiles: [{ id: "bun-check-fast", concurrency: 1, tasks: [{ id: "check:fast" }] }],
      }),
    (error) => {
      assert.ok(error instanceof CapabilityInputError);
      assert.match(error.message, /profiles\[0\]\.packageManager/u);
      return true;
    },
  );
});

// Catches Bun being reduced to pnpm semantics or adding shell-like arguments.
test("Bun package-script adapter invokes exactly bun run <id>", async () => {
  const processExecutor = new RecordingManagedProcessExecutor();
  await new BunQualityGateScriptExecutor(
    {
      childEnvironment: Object.freeze({ LEAF_RUNTIME: "bun" }),
      bunExecutablePath: "/verified/bun",
    },
    processExecutor,
  ).run({
    packageManager: "bun",
    consumerRoot: "/fixture",
    scriptId: "check:fast",
  });
  assert.deepEqual(
    processExecutor.requests.map(({ command, args, cwd }) => [command, args, cwd]),
    [["/verified/bun", ["run", "check:fast"], "/fixture"]],
  );
});

// Catches unknown managers or generic-command dispatch before adapter effects.
test("closed manager switch dispatches known managers and rejects mismatches before effects", async () => {
  let effects = 0;
  const executor = createPackageManagerScriptExecutor({
    bun: {
      async run(input) {
        effects += 1;
        assert.equal(input.packageManager, "bun");
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      },
    },
    pnpm: {
      async run() {
        effects += 1;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      },
    },
  });
  await executor.run({
    packageManager: "bun",
    consumerRoot: "/fixture",
    scriptId: "check:fast",
  });
  await assert.rejects(
    executor.run({
      packageManager: "mismatched",
      consumerRoot: "/fixture",
      scriptId: "check:fast",
    }),
    /unavailable or mismatched/u,
  );
  assert.equal(effects, 1);
});

// Catches Bun's process.execPath being mislabeled as the verified Node bootstrap.
test("runtime selection requires explicit verified Node under Bun", async () => {
  const selection = await resolveRepositoryRuntimeExecutables({
    environment: {
      AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "bun",
      AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: "/verified/node",
    },
    currentExecutablePath: "/verified/bun",
    currentRuntime: "bun",
    verifyExecutable: async (path, runtime) =>
      (runtime === "node" && path === "/verified/node") ||
      (runtime === "bun" && path === "/verified/bun"),
  });
  assert.equal(selection.executables.node, "/verified/node");
  assert.equal(selection.executables.bun, "/verified/bun");
  await assert.rejects(
    resolveRepositoryRuntimeExecutables({
      environment: { AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "bun" },
      currentExecutablePath: "/verified/bun",
      currentRuntime: "bun",
      verifyExecutable: async () => true,
    }),
    /explicit verified Node executable/u,
  );
});

test("quality gate configuration preserves injected schema rejection before graph mapping", async () => {
  const failure = new Error("explicit schema rejection");
  let attempts = 0;
  await assert.rejects(
    loadQualityGatePolicy(
      {
        async readYaml() {
          return null;
        },
        async assertSchema() {
          attempts += 1;
          throw failure;
        },
      },
      "explicit-memory-consumer",
      "quality-gates.yaml",
    ),
    (error) => error === failure,
  );
  assert.equal(attempts, 1);
});

test("quality gate configuration preserves graph errors after schema validation", async () => {
  const input = {
    profiles: [{ id: "verify", concurrency: 1, tasks: [{ id: "build", needs: ["missing"] }] }],
  };
  let validated = false;
  await assert.rejects(
    loadQualityGatePolicy(
      {
        async readYaml() {
          return input;
        },
        async assertSchema() {
          validated = true;
        },
      },
      "explicit-memory-consumer",
      "quality-gates.yaml",
    ),
    (error) => {
      assert.ok(error instanceof CapabilityInputError);
      assert.equal(error.problem.code, "QUALITY_GATE_RUNNER_CONFIG_INVALID");
      assert.equal(error.problem.phase, "quality-gate-runner-config");
      assert.equal(error.message, "Profile verify task build references unknown task missing.");
      return true;
    },
  );
  assert.equal(validated, true);
});

// Reject future versions before selecting either existing schema family.
test("quality gate configuration rejects unsupported versions before schema validation", async () => {
  let schemaCalls = 0;
  await assert.rejects(
    loadQualityGatePolicy(
      {
        async readYaml() {
          return { schemaVersion: 3 };
        },
        async assertSchema() {
          schemaCalls += 1;
        },
      },
      "explicit-memory-consumer",
      "quality-gates.yaml",
    ),
    (error) => {
      assert.ok(error instanceof CapabilityInputError);
      assert.equal(error.problem.code, "QUALITY_GATE_RUNNER_CONFIG_INVALID");
      assert.equal(error.message, "schemaVersion must be 1 or 2.");
      return true;
    },
  );
  assert.equal(schemaCalls, 0);
});

// Both concrete managers must preserve the same Host containment failure semantics.
test("shared package-script execution translates only timeout and completed cancellation", async () => {
  const { runPackageScriptProcess } =
    await import("../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/outbound/package-script-process.js");
  const { ProcessCancellationError, ProcessTimeoutError } =
    await import("../packages/engineering-foundation/dist/process-execution/api.js");
  const { PackageScriptCancellationError, PackageScriptTimeoutError } =
    await import("../packages/engineering-foundation/dist/capabilities/quality-gate-runner/application/ports/package-script-executor.js");
  const request = { command: "owned-runtime", args: [], cwd: "TEST-only" };
  for (const [cause, translated] of [
    [new ProcessCancellationError("cancelled"), PackageScriptCancellationError],
    [new ProcessTimeoutError(250), PackageScriptTimeoutError],
  ]) {
    await assert.rejects(
      runPackageScriptProcess(
        {
          async run() {
            throw cause;
          },
        },
        request,
      ),
      (error) => {
        assert.ok(error instanceof translated);
        assert.equal(error.cause, cause);
        if (cause instanceof ProcessTimeoutError) {
          assert.equal(error.timeoutMs, 250);
        }
        return true;
      },
    );
  }
  const incompleteCleanup = new Error("incomplete cleanup");
  await assert.rejects(
    runPackageScriptProcess(
      {
        async run() {
          throw incompleteCleanup;
        },
      },
      request,
    ),
    (error) => error === incompleteCleanup,
  );
  const result = await runPackageScriptProcess(
    new RecordingManagedProcessExecutor({
      exitCode: 1,
      signal: "SIGTERM",
      stdout: "observed",
      stderr: "detail",
    }),
    request,
  );
  assert.deepEqual(result, {
    exitCode: null,
    signal: "SIGTERM",
    stdout: "observed",
    stderr: "detail",
  });
});

test("workflow runner rejects a missing manager through its Promise contract", async () => {
  const { createPackageManagerScriptRunner } =
    await import("../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/composition/select-package-script-runner.js");
  let result;
  assert.doesNotThrow(() => {
    result = createPackageManagerScriptRunner({}).run({
      packageManager: "bun",
      consumerRoot: "TEST-only",
      script: "check",
      paths: [],
    });
  });
  assert.ok(result instanceof Promise);
  await assert.rejects(result, /Package manager/u);
});

test("Bun workflow rejection names the missing Bun executable", async () => {
  const { BunPackageScriptRunner } =
    await import("../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/bun/bun-package-script-runner.js");
  await assert.rejects(
    new BunPackageScriptRunner({}, async () => {
      throw new Error("must not execute");
    }).run({
      packageManager: "bun",
      consumerRoot: "TEST-only",
      script: "check",
      paths: [],
    }),
    /verified Bun executable/u,
  );
});
