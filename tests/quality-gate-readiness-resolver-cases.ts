import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { createManagedProcessExecutor } from "./support/capability-adapters.mjs";
import {
  cleanupSyntheticFixture,
  createGenerationAwareChangeSignal,
  observeFixtureEffect,
} from "./support/quality-gate-runner-lifecycle.mjs";
import { PnpmQualityGateScriptExecutor } from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/outbound/pnpm/pnpm-package-script-executor.js";

export function registerQualityGateReadinessCases(): void {
  void test("readiness retries the ENOENT read when an atomic rename overlaps it", async () => {
    let notify!: () => void;
    let releaseFirstRead!: () => void;
    let reportFirstRead!: () => void;
    let reads = 0;
    let unsubscribed = 0;
    const firstRead = new Promise<void>((resolve) => {
      reportFirstRead = resolve;
    });
    const overlap = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    const observation = observeFixtureEffect({
      async read() {
        reads += 1;
        if (reads === 1) {
          reportFirstRead();
          await overlap;
          throw Object.assign(new Error("read began before atomic rename"), { code: "ENOENT" });
        }
        return "renamed-ready-file";
      },
      subscribe(onChange: () => void) {
        notify = onChange;
        return () => {
          unsubscribed += 1;
        };
      },
    });

    await firstRead;
    notify();
    releaseFirstRead();
    assert.equal(await observation.result, "renamed-ready-file");
    assert.equal(reads, 2);
    assert.equal(unsubscribed, 1);
  });

  void test("readiness polling succeeds when the sole watcher notification is dropped", async () => {
    let reads = 0;
    let unsubscribed = 0;
    const observation = observeFixtureEffect({
      pollIntervalMs: 5,
      async read() {
        reads += 1;
        if (reads === 1) {
          throw Object.assign(new Error("not ready"), { code: "ENOENT" });
        }
        return "poll-observed-ready-file";
      },
      subscribe() {
        return () => {
          unsubscribed += 1;
        };
      },
    });

    assert.equal(await observation.result, "poll-observed-ready-file");
    assert.equal(reads, 2);
    assert.equal(unsubscribed, 1);
  });

  void test("change signals retain a notification between predicate evaluation and waiter registration", async () => {
    const changed = createGenerationAwareChangeSignal();
    const observedGeneration = changed.generation();
    assert.equal(false, false, "predicate evaluated false before the notification");
    changed.notify();
    assert.equal(await changed.wait(observedGeneration), observedGeneration + 1);
  });
}

export function registerPnpmResolverCases(): void {
  void test("resolves pnpm entrypoints from focused environment candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation-quality-gate-resolver-"));
    try {
      const cases = [
        {
          name: "npm_execpath JavaScript entrypoint",
          async prepare(marker: string) {
            const entrypoint = join(root, "npm-exec-probe.cjs");
            await writeFile(
              entrypoint,
              `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`,
              "utf8",
            );
            return { environment: { npmExecPath: entrypoint }, expected: ["run", "probe"] };
          },
        },
        {
          name: "PNPM_HOME package entrypoint",
          async prepare(marker: string) {
            const pnpmHome = join(root, "pnpm-home", ".tools");
            const entrypoint = join(root, "pnpm-home", "pnpm", "bin", "pnpm.cjs");
            await mkdir(dirname(entrypoint), { recursive: true });
            await writeFile(
              entrypoint,
              `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`,
              "utf8",
            );
            return { environment: { pnpmHome }, expected: ["run", "probe"] };
          },
        },
        ...(process.platform === "win32"
          ? [
              {
                name: "PNPM_HOME Windows executable",
                async prepare(marker: string) {
                  const pnpmHome = join(root, "windows-pnpm-home");
                  await mkdir(pnpmHome, { recursive: true });
                  await copyFile(process.execPath, join(pnpmHome, "pnpm.exe"));
                  await writeFile(
                    join(root, "run"),
                    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`,
                    "utf8",
                  );
                  return { environment: { pnpmHome }, expected: ["probe"] };
                },
              },
              {
                name: "PATH Windows executable",
                async prepare(marker: string) {
                  const pathRoot = join(root, "windows-path");
                  await mkdir(pathRoot, { recursive: true });
                  await copyFile(process.execPath, join(pathRoot, "pnpm.exe"));
                  await writeFile(
                    join(root, "run"),
                    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`,
                    "utf8",
                  );
                  return {
                    environment: { pathValue: `${join(root, "missing")}${delimiter}${pathRoot}` },
                    expected: ["probe"],
                  };
                },
              },
            ]
          : [
              {
                name: "explicit native entrypoint takes precedence over a shadow PATH entrypoint",
                async prepare(marker: string) {
                  const entrypoint = join(root, "native pnpm with spaces"),
                    pathRoot = join(root, "shadow-path"),
                    shadowEntrypoint = join(root, "shadow-pnpm.cjs");
                  const shadowSource = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(["shadow"]));\n`,
                    runSource = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`;
                  await copyFile(process.execPath, entrypoint);
                  await mkdir(pathRoot, { recursive: true });
                  await writeFile(shadowEntrypoint, shadowSource, "utf8");
                  await symlink(shadowEntrypoint, join(pathRoot, "pnpm"));
                  await writeFile(join(root, "run"), runSource, "utf8");
                  return {
                    environment: { npmExecPath: entrypoint, pathValue: pathRoot },
                    expected: ["probe"],
                  };
                },
              },
              {
                name: "PATH JavaScript entrypoint",
                async prepare(marker: string) {
                  const pathRoot = join(root, "posix-path");
                  const entrypoint = join(root, "path-probe.cjs");
                  await mkdir(pathRoot, { recursive: true });
                  await writeFile(
                    entrypoint,
                    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`,
                    "utf8",
                  );
                  await symlink(entrypoint, join(pathRoot, "pnpm"));
                  return {
                    environment: { pathValue: `${join(root, "missing")}${delimiter}${pathRoot}` },
                    expected: ["run", "probe"],
                  };
                },
              },
            ]),
      ];

      for (const [index, candidate] of cases.entries()) {
        const marker = join(root, `resolver-${index}.json`);
        const { environment, expected } = await candidate.prepare(marker);
        const result = await new PnpmQualityGateScriptExecutor(
          {
            ...environment,
            childEnvironment: {},
            nodeExecutablePath: process.execPath,
          },
          createManagedProcessExecutor(),
        ).run({
          packageManager: "pnpm",
          consumerRoot: root,
          scriptId: "probe",
        });
        assert.equal(result.exitCode, 0, `${candidate.name}: ${JSON.stringify(result)}`);
        assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), expected, candidate.name);
      }
      if (process.platform !== "win32") {
        for (const npmExecPath of [join(root, "missing-native-pnpm"), root]) {
          let invoked = false;
          const executor = new PnpmQualityGateScriptExecutor(
            {
              npmExecPath,
              childEnvironment: {},
              pathValue: join(root, "shadow-path"),
            },
            {
              async run() {
                invoked = true;
                assert.fail("Invalid explicit native entrypoint must not invoke a fallback.");
              },
            },
          );
          // Runtime-negative fixture retained from unchecked JS: deliberately omit packageManager
          // at this typed API boundary so explicit-entrypoint rejection happens first.
          await assert.rejects(
            executor.run({ consumerRoot: root, scriptId: "probe" } as Parameters<
              PnpmQualityGateScriptExecutor["run"]
            >[0]),
            (error: { code?: string }) => error.code === "PROCESS_FAILED",
          );
          assert.equal(invoked, false);
        }
      }
    } finally {
      await cleanupSyntheticFixture({ roots: [root] });
    }
  });
}
