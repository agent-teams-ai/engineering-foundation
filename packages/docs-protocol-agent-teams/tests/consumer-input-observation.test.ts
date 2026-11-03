import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { readStableConsumerFile } from "../dist/consumer-integration/adapters/node-consumer-repository-files.js";
import { desired, managedDesired } from "./consumer-plan-v3-fixture.ts";

async function fixture(t: TestContext): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "TEST-consumer-input-")));
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

void test("managed input bounds actual bytes when an admitted regular file grows", async (t) => {
  const root = await fixture(t);
  const path = join(root, "input.json");
  await fs.writeFile(path, "text");
  const originalOpen = fs.open;
  let bytesRead = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] !== path) {
      return handle;
    }
    let first = true;
    handle.stat = new Proxy(handle.stat.bind(handle), {
      async apply(target, receiver: unknown, parameters: unknown[]) {
        const state: unknown = await Reflect.apply(target, receiver, parameters);
        if (first) {
          first = false;
          await fs.appendFile(path, Buffer.alloc(1024 * 1024, 65));
        }
        return state;
      },
    });
    handle.read = new Proxy(handle.read.bind(handle), {
      async apply(target, receiver: unknown, parameters: unknown[]) {
        const result = (await Reflect.apply(target, receiver, parameters)) as { bytesRead: number };
        bytesRead += result.bytesRead;
        return result;
      },
    });
    handle.readFile = new Proxy(handle.readFile.bind(handle), {
      async apply(target, receiver: unknown, parameters: unknown[]) {
        const result = (await Reflect.apply(target, receiver, parameters)) as Buffer;
        bytesRead += result.byteLength;
        return result;
      },
    });
    return handle;
  });
  syncBuiltinESMExports();
  await assert.rejects(readStableConsumerFile(root, "input.json", 8, true));
  assert.ok(bytesRead > 0 && bytesRead <= 9, `actual bounded read consumed ${bytesRead} bytes`);
});

for (const change of ["disappear", "replace", "hardlink"] as const) {
  void test(`managed input rejects ${change} after physical read instead of optional absence`, async (t) => {
    const root = await fixture(t);
    const path = join(root, "input.json");
    await fs.writeFile(path, "original\n");
    const originalOpen = fs.open;
    let changed = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] !== path) {
        return handle;
      }
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        if (changed) {
          return;
        }
        changed = true;
        if (change === "disappear") {
          await fs.rm(path);
        }
        if (change === "replace") {
          await fs.rename(path, `${path}.old`);
          await fs.writeFile(path, "original\n");
        }
        if (change === "hardlink") {
          await fs.link(path, `${path}.alias`);
        }
      };
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(readStableConsumerFile(root, "input.json", 1024, false), {
      code: "DOCS_CONSUMER_INPUT_UNSTABLE",
    });
    assert.equal(changed, true, "race occurs after a successful physical read");
  });
}

void test("managed input preserves bytes, permission mode and initial optional absence", async (t) => {
  const root = await fixture(t);
  const path = join(root, "input.json");
  const bytes = Buffer.from([0, 255, 10, 42]);
  await fs.writeFile(path, bytes, { mode: 0o600 });
  const observation = await readStableConsumerFile(root, "input.json", 4, true);
  assert.equal(observation.state, "file");
  assert.deepEqual(observation.bytes, bytes);
  assert.equal(observation.mode, (await fs.stat(path)).mode & 0o777);
  await assert.rejects(readStableConsumerFile(root, "input.json", 3, true), {
    code: "DOCS_CONSUMER_INPUT_INVALID",
  });
  assert.deepEqual(await readStableConsumerFile(root, "missing", 4, false), { state: "absent" });
  await assert.rejects(readStableConsumerFile(root, "missing", 4, true), {
    code: "DOCS_CONSUMER_INPUT_MISSING",
  });
  await assert.rejects(readStableConsumerFile(root, "../outside", 4, false), {
    code: "DOCS_CONSUMER_PATH_ESCAPE",
  });
  await fs.mkdir(join(root, "directory"));
  await assert.rejects(readStableConsumerFile(root, "directory", 4, false), {
    code: "DOCS_CONSUMER_INPUT_INVALID",
  });
  await fs.link(path, `${path}.hardlink`);
  await assert.rejects(readStableConsumerFile(root, "input.json", 4, true), {
    code: "DOCS_CONSUMER_INPUT_INVALID",
  });
  await fs.rm(`${path}.hardlink`);
  await fs.symlink(path, `${path}.symlink`, "file");
  await assert.rejects(readStableConsumerFile(root, "input.json.symlink", 4, false));
  await fs.symlink(root, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readStableConsumerFile(root, "alias/input.json", 4, true), {
    code: "DOCS_CONSUMER_INPUT_UNSTABLE",
  });
});

void test(
  "public managed input rejects a FIFO manifest without recovery state",
  {
    skip:
      process.platform === "win32"
        ? "POSIX FIFO observation; Windows regular-file cases run above"
        : false,
  },
  async (t) => {
    const root = await fixture(t);
    const profile = process.versions.node.startsWith("26.") ? managedDesired() : desired();
    if (profile.schemaVersion === 4) {
      const runtime = profile.cohort.runtime.qualificationRuntime;
      if (
        runtime.nodeVersion !== process.versions.node ||
        runtime.platform !== process.platform ||
        runtime.architecture !== process.arch
      ) {
        t.skip("public profile4 reader requires its exact packed qualification runtime");
        return;
      }
    }
    const initialized = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    await fs.mkdir(join(root, "architecture/foundation"), { recursive: true });
    await fs.writeFile(
      join(root, "architecture/foundation/docs-consumer-integration.json"),
      JSON.stringify(profile),
    );
    await fs.writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const fifo = spawnSync("mkfifo", [join(root, "package.json")], { encoding: "utf8" });
    assert.equal(fifo.status, 0, fifo.stderr);
    const before = (await fs.readdir(root)).toSorted();
    const {
      GITHUB_REPOSITORY: _repository,
      GITHUB_REPOSITORY_ID: _repositoryId,
      ...environment
    } = process.env;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
    const { readConsumerIntegrationInput } = await import(process.argv[1]);
    try { await readConsumerIntegrationInput({ consumerRoot: process.argv[2] }); process.exitCode = 1; }
    catch (error) { console.log(JSON.stringify({ code: error.code })); }
  `,
        new URL("../dist/index.js", import.meta.url).href,
        root,
      ],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: environment,
      },
    );
    assert.equal(result.error, undefined, `public reader must terminate: ${String(result.error)}`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { code: "DOCS_CONSUMER_INPUT_INVALID" });
    assert.deepEqual((await fs.readdir(root)).toSorted(), before);
    assert.equal((await fs.lstat(join(root, "package.json"))).isFIFO(), true);
  },
);
