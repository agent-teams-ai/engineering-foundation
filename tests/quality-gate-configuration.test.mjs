import assert from "node:assert/strict";
import test from "node:test";
import { assertFeatureOutsideSchemaCycles, assertSchemaAssemblyImportRejected } from "./helpers/schema-assembly-boundaries.mjs";
import { loadQualityGatePolicy } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/inbound/configuration/load-quality-gate-policy.js";
import { parseQualityGatePolicy } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/inbound/configuration/parse-quality-gate-policy.js";
import { CapabilityInputError } from "../packages/engineering-foundation/dist/features/validation-reporting/api.js";
import { assertSchema as assertFoundationSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";
import { BunQualityGateScriptExecutor } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/outbound/bun/bun-package-script-executor.js";
import { createPackageManagerScriptExecutor } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/composition/select-package-script-executor.js";
import { resolveRepositoryRuntimeExecutables } from "../packages/engineering-foundation/dist/process-execution/application/runtime-selection.js";
import { RecordingManagedProcessExecutor } from "./support/quality-gate-runtime-adapters.mts";

test("quality gate configuration no longer joins the module schema assembly cycle", async () => {
  await assertFeatureOutsideSchemaCycles("quality-gate-runner");
});

test("source policy rejects reintroducing schema assembly inside the quality gate adapter", async () => {
  await assertSchemaAssemblyImportRejected(
    "packages/engineering-foundation/src/capabilities/quality-gate-runner/adapters/inbound/configuration/load-quality-gate-policy.ts",
    "../../../../../schema-catalog.js"
  );
});

test("quality gate configuration retains the dependency trace and immutable task graph", async () => {
  const input = { schemaVersion: 1, packageManager: "pnpm", profiles: [
    { id: "verify", concurrency: 2, tasks: [{ id: "build" }, { id: "test", needs: ["build"], timeoutMs: 5000 }] }
  ] };
  const calls = [], signal = new AbortController().signal;
  const policy = await loadQualityGatePolicy({
    async readYaml(...args) { calls.push(["read", ...args]); return input; },
    async assertSchema(...args) { calls.push(["schema", ...args]); }
  }, "explicit-memory-consumer", "quality-gates.yaml", signal);
  assert.deepEqual(calls, [
    ["read", "explicit-memory-consumer", "quality-gates.yaml", "quality-gate-runner-config", signal],
    ["schema", "quality-gate-runner/v1", input, "quality-gate-runner-config"]
  ]);
  assert.deepEqual(policy, { profiles: [
    { id: "verify", packageManager: "pnpm", concurrency: 2, tasks: [
      { id: "build", needs: [], after: [] },
      { id: "test", needs: ["build"], after: [], timeoutMs: 5000 }
    ] }
  ] });
  assert.deepEqual(parseQualityGatePolicy(input), policy);
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.profiles[0].tasks));
  assert.ok(Object.isFrozen(policy.profiles[0].tasks[1].needs));
});

// Catches v1 configurations silently gaining a profile-manager requirement.
test("quality gate v1 normalizes its root pnpm manager onto each internal profile", () => {
  const parsed = parseQualityGatePolicy({
    schemaVersion: 1,
    packageManager: "pnpm",
    profiles: [{ id: "bun-shaped", concurrency: 1, tasks: [{ id: "build" }] }]
  });
  assert.deepEqual(parsed.profiles.map(({ packageManager }) => packageManager), ["pnpm"]);
});

// Catches v2 profiles being forced through one manager or the legacy root field.
test("quality gate v2 selects bun or pnpm independently per named profile", async () => {
  const input = {
    schemaVersion: 2,
    profiles: [
      { id: "bun-check-fast", packageManager: "bun", concurrency: 1, tasks: [{ id: "check:fast" }] },
      { id: "node-check-fast", packageManager: "pnpm", concurrency: 1, tasks: [{ id: "check:fast" }] }
    ]
  };
  const calls = [];
  const parsed = await loadQualityGatePolicy({
    async readYaml() { return input; },
    async assertSchema(...args) {
      calls.push(args);
      await assertFoundationSchema(...args);
    }
  }, "explicit-memory-consumer", "quality-gates-v2.yaml");
  assert.deepEqual(calls.map(([id]) => id), ["quality-gate-runner/v2"]);
  assert.deepEqual(parsed.profiles.map(({ id, packageManager }) => [id, packageManager]), [
    ["bun-check-fast", "bun"],
    ["node-check-fast", "pnpm"]
  ]);
});

// Catches v2 silently falling back to the v1 root manager when a profile omits its own.
test("quality gate v2 rejects a profile without an explicit manager", async () => {
  await assert.rejects(loadQualityGatePolicy({
    async readYaml() {
      return {
        schemaVersion: 2,
        profiles: [{ id: "bun-check-fast", concurrency: 1, tasks: [{ id: "check:fast" }] }]
      };
    },
    assertSchema: assertFoundationSchema
  }, "explicit-memory-consumer", "quality-gates-v2.yaml"), (error) => {
    assert.match(String(error), /packageManager/u);
    return true;
  });
  assert.throws(() => parseQualityGatePolicy({
    schemaVersion: 2,
    profiles: [{ id: "bun-check-fast", concurrency: 1, tasks: [{ id: "check:fast" }] }]
  }), (error) => {
    assert.ok(error instanceof CapabilityInputError);
    assert.match(error.message, /profiles\[0\]\.packageManager/u);
    return true;
  });
});

// Catches Bun being reduced to pnpm semantics or adding shell-like arguments.
test("Bun package-script adapter invokes exactly bun run <id>", async () => {
  const processExecutor = new RecordingManagedProcessExecutor();
  await new BunQualityGateScriptExecutor({
    childEnvironment: Object.freeze({ LEAF_RUNTIME: "bun" }),
    bunExecutablePath: "/verified/bun"
  }, processExecutor).run({
    packageManager: "bun",
    consumerRoot: "/fixture",
    scriptId: "check:fast"
  });
  assert.deepEqual(processExecutor.requests.map(({ command, args, cwd }) => [command, args, cwd]), [
    ["/verified/bun", ["run", "check:fast"], "/fixture"]
  ]);
});

// Catches manager dispatch occurring before policy validation or through a generic command.
test("closed manager switch dispatches after validation and rejects mismatches before effects", async () => {
  let effects = 0;
  const executor = createPackageManagerScriptExecutor({
    bun: { async run(input) {
      effects += 1;
      assert.equal(input.packageManager, "bun");
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    } },
    pnpm: { async run() {
      effects += 1;
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    } }
  });
  await executor.run({
    packageManager: "bun",
    consumerRoot: "/fixture",
    scriptId: "check:fast"
  });
  await assert.rejects(executor.run({
    packageManager: "mismatched",
    consumerRoot: "/fixture",
    scriptId: "check:fast"
  }), /unavailable or mismatched/u);
  assert.equal(effects, 1);
});

// Catches Bun's process.execPath being mislabeled as the verified Node bootstrap.
test("runtime selection requires explicit verified Node under Bun", async () => {
  const selection = await resolveRepositoryRuntimeExecutables({
    environment: {
      AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "bun",
      AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: "/verified/node"
    },
    currentExecutablePath: "/verified/bun",
    currentRuntime: "bun",
    verifyExecutable: async (path, runtime) =>
      (runtime === "node" && path === "/verified/node") ||
      (runtime === "bun" && path === "/verified/bun")
  });
  assert.equal(selection.executables.node, "/verified/node");
  assert.equal(selection.executables.bun, "/verified/bun");
  await assert.rejects(resolveRepositoryRuntimeExecutables({
    environment: { AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "bun" },
    currentExecutablePath: "/verified/bun",
    currentRuntime: "bun",
    verifyExecutable: async () => true
  }), /explicit verified Node executable/u);
});

test("quality gate configuration preserves injected schema rejection before graph mapping", async () => {
  const failure = new Error("explicit schema rejection");
  let attempts = 0;
  await assert.rejects(loadQualityGatePolicy({
    async readYaml() { return null; },
    async assertSchema() { attempts += 1; throw failure; }
  }, "explicit-memory-consumer", "quality-gates.yaml"), (error) => error === failure);
  assert.equal(attempts, 1);
});

test("quality gate configuration preserves graph errors after schema validation", async () => {
  const input = { profiles: [{ id: "verify", concurrency: 1, tasks: [{ id: "build", needs: ["missing"] }] }] };
  let validated = false;
  await assert.rejects(loadQualityGatePolicy({
    async readYaml() { return input; },
    async assertSchema() { validated = true; }
  }, "explicit-memory-consumer", "quality-gates.yaml"), (error) => {
    assert.ok(error instanceof CapabilityInputError);
    assert.equal(error.problem.code, "QUALITY_GATE_RUNNER_CONFIG_INVALID");
    assert.equal(error.problem.phase, "quality-gate-runner-config");
    assert.equal(error.message, "Profile verify task build references unknown task missing.");
    return true;
  });
  assert.equal(validated, true);
});
