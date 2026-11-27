import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { NodeConsumerUpgradeSandbox } from "../../../dist/consumer-integration/adapters/node-consumer-upgrade-sandbox.js";
import { assertFrozenTargetLockInstall } from "./consumer-target-lock-input-assertions.ts";
import {
  at,
  encoded,
  record,
  seedManagedTargetLockSandbox,
} from "./consumer-managed-target-lock-fixture.ts";

type SandboxFixture = Awaited<ReturnType<typeof seedManagedTargetLockSandbox>>;
interface Effects {
  readonly installs: string[][];
  stagedRoot: string | undefined;
  tamper: "none" | "install" | "apply" | "capture";
}

function interceptProcesses(t: TestContext, f: SandboxFixture, effects: Effects): void {
  const original = childProcess.execFile;
  t.mock.method(
    childProcess,
    "execFile",
    new Proxy(original, {
      apply(execute, receiver: unknown, parameters: unknown[]) {
        const [executable, rawArgs, rawOptions, callback] = parameters;
        assert.ok(typeof executable === "string");
        assert.ok(
          Array.isArray(rawArgs) && rawArgs.every((value: unknown) => typeof value === "string"),
        );
        assert.ok(typeof callback === "function");
        const args: string[] = rawArgs;
        if (executable === "git" || executable === "tar") {
          if (
            executable === "git" &&
            args[0] === "status" &&
            effects.tamper === "capture" &&
            effects.stagedRoot !== undefined
          ) {
            writeFileSync(
              join(effects.stagedRoot, "pnpm-lock.yaml"),
              Buffer.concat([f.selectedBytes, Buffer.from("\n")]),
            );
          }
          return Reflect.apply(execute, receiver, parameters);
        }
        const cwd = record(rawOptions)["cwd"];
        assert.ok(typeof cwd === "string");
        const effect = async (): Promise<string> => {
          assert.ok(
            executable === f.environment["AGENT_TEAMS_DOCS_UPGRADE_NODE24_EXECUTABLE"] ||
              executable === f.environment["AGENT_TEAMS_DOCS_UPGRADE_NODE26_EXECUTABLE"],
          );
          const corepack = f.environment["AGENT_TEAMS_DOCS_UPGRADE_COREPACK_ENTRYPOINT"];
          if (args.includes("--eval")) {
            const node =
              executable === f.environment["AGENT_TEAMS_DOCS_UPGRADE_NODE24_EXECUTABLE"]
                ? "24.22.3"
                : "26.12.1";
            return JSON.stringify({ node, platform: "linux", architecture: "x64" });
          }
          if (args[0] === corepack && args.includes("--version")) {
            return "11.20.0\n";
          }
          if (args[0] === corepack && args.includes("install")) {
            effects.stagedRoot = cwd;
            effects.installs.push(args.slice(1));
            assert.deepEqual(await readFile(join(cwd, "pnpm-lock.yaml")), f.selectedBytes);
            const cli = join(
              cwd,
              "node_modules/@agent-teams/docs-protocol-agent-teams/dist/cli.js",
            );
            await mkdir(dirname(cli), { recursive: true });
            await writeFile(cli, "// inert fixture CLI; every call is intercepted\n");
            if (effects.tamper === "install") {
              await writeFile(join(cwd, "pnpm-lock.yaml"), "install drift");
            }
            return "";
          }
          if (args[1] === "plan") {
            return JSON.stringify({
              outcome: "change-required",
              plan: { planDigest: "sha256:" + "a".repeat(64) },
            });
          }
          if (args[1] === "apply") {
            for (const path of [
              f.current.skillPath,
              f.current.callerWorkflowPath,
              f.current.managedStatePath,
            ]) {
              await writeFile(join(cwd, path), "fixture target asset\n");
            }
            if (effects.tamper === "apply") {
              await writeFile(join(cwd, "pnpm-lock.yaml"), "apply drift");
            }
            return JSON.stringify({ outcome: "applied" });
          }
          assert.equal(args[1], "check");
          return JSON.stringify({ outcome: "current" });
        };
        void effect().then(
          (stdout) => setImmediate(() => Reflect.apply(callback, undefined, [null, stdout, ""])),
          (error: unknown) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            setImmediate(() =>
              Reflect.apply(callback, undefined, [
                Object.assign(failure, { code: 1 }),
                "",
                failure.message,
              ]),
            );
          },
        );
        return new childProcess.ChildProcess();
      },
    }),
  );
  syncBuiltinESMExports();
}

async function managedSandboxSelection(t: TestContext): Promise<void> {
  const f = await seedManagedTargetLockSandbox();
  const effects: Effects = { installs: [], stagedRoot: undefined, tamper: "none" };
  interceptProcesses(t, f, effects);
  const sandbox = new NodeConsumerUpgradeSandbox(() => f.environment);
  const prepare = (selected: Uint8Array) => {
    effects.stagedRoot = undefined;
    return sandbox.prepareManaged({ ...f.options, targetLockfile: selected });
  };
  try {
    const wrongClosure = structuredClone(f.after);
    const foundation =
      "@agent-teams/engineering-foundation@" +
      f.successor.cohort.packages.engineeringFoundation.version;
    at(wrongClosure, "snapshots", foundation, "dependencies")["@types/node"] = "24.13.3";
    await assert.rejects(prepare(encoded(wrongClosure)), {
      code: "DOCS_CONSUMER_RUNTIME_CLOSURE_MISMATCH",
    });
    assert.equal(effects.installs.length, 0);
    const mutableInput = Buffer.from(f.selectedBytes);
    const pending = prepare(mutableInput);
    mutableInput.fill(0);
    const result = await pending;
    const lock = result.operations.find((entry) => entry.path === "pnpm-lock.yaml");
    assert.ok(lock);
    assert.deepEqual(lock.postimage.bytes, f.selectedBytes);
    assert.equal(lock.precondition.state, "known-file");
    assert.deepEqual(lock.precondition.acceptedPreimages[0]?.bytes, f.beforeBytes);
    assertFrozenTargetLockInstall(effects.installs[0]);
    assert.ok(!result.operations.some((entry) => entry.path === ".node-version"));
    effects.tamper = "install";
    await assert.rejects(prepare(f.selectedBytes), /bytes changed/u);
    effects.tamper = "apply";
    await assert.rejects(prepare(f.selectedBytes), /bytes changed/u);
    effects.tamper = "capture";
    await assert.rejects(prepare(f.selectedBytes), /Captured target lock/u);
    assert.deepEqual(await readFile(join(f.consumer, "pnpm-lock.yaml")), f.beforeBytes);
    assert.equal(await readFile(join(f.consumer, ".node-version"), "utf8"), "26.12.1\n");
    assert.equal(
      await readFile(join(f.consumer, "packages/host/package.json"), "utf8"),
      JSON.stringify({
        name: "TEST-foreign-host",
        private: true,
        devDependencies: { "@types/node": "24.13.3" },
      }),
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(f.root, { recursive: true, force: true });
  }
}

export function registerManagedTargetLockSandboxTests(): void {
  void test(
    "managed target lock sandbox freezes retained bytes and rejects install, apply and capture drift",
    managedSandboxSelection,
  );
}
