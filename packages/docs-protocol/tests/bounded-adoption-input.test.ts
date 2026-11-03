import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { readContainedText } from "../dist/features/portable-documentation/adapters/outbound/adoption-input.js";

async function fixture(t: TestContext): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "TEST-adoption-input-")));
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test("adoption bounds actual bytes when an admitted regular file grows", async (t) => {
  const root = await fixture(t);
  const path = join(root, "authority.md");
  await fs.writeFile(path, "text");
  const originalOpen = fs.open;
  let bytesRead = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] !== path) return handle;
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
  await assert.rejects(readContainedText(root, "authority.md", 8), { name: "AdoptionInputError" });
  assert.ok(bytesRead > 0 && bytesRead <= 9, `actual bounded read consumed ${bytesRead} bytes`);
});

for (const change of ["disappear", "replace", "hardlink"] as const) {
  test(`adoption rejects ${change} after physical read and before owner recheck`, async (t) => {
    const root = await fixture(t);
    const path = join(root, "authority.md");
    await fs.writeFile(path, "original\n");
    const originalOpen = fs.open;
    let changed = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] !== path) return handle;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        if (changed) return;
        changed = true;
        if (change === "disappear") await fs.rm(path);
        if (change === "replace") {
          await fs.rename(path, `${path}.old`);
          await fs.writeFile(path, "original\n");
        }
        if (change === "hardlink") await fs.link(path, `${path}.alias`);
      };
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(readContainedText(root, "authority.md", 1024), {
      name: "AdoptionInputError",
    });
    assert.equal(changed, true, "race occurs after a successful physical read");
  });
}

test("adoption preserves contained regular text and rejects invalid authority inputs", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(join(root, "valid.md"), "Документ\n");
  assert.equal(await readContainedText(root, "valid.md", 128), "Документ\n");
  await assert.rejects(readContainedText(root, "missing.md", 128));
  await assert.rejects(readContainedText(root, "../outside.md", 128), /escapes/u);
  await fs.mkdir(join(root, "directory"));
  await assert.rejects(readContainedText(root, "directory", 128), /regular file/u);
  await fs.link(join(root, "valid.md"), join(root, "hardlink.md"));
  await assert.rejects(readContainedText(root, "hardlink.md", 128), /non-hardlinked/u);
  await fs.rm(join(root, "hardlink.md"));
  await fs.symlink(join(root, "valid.md"), join(root, "symlink.md"), "file");
  await assert.rejects(readContainedText(root, "symlink.md", 128), /symbolic links/u);
  await fs.symlink(root, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readContainedText(root, "alias/valid.md", 128), /symbolic links/u);
  for (const bytes of [Buffer.from([0xff]), Buffer.from("\uFEFFtext"), Buffer.from("a\0b")]) {
    await fs.writeFile(join(root, "invalid.md"), bytes);
    await assert.rejects(readContainedText(root, "invalid.md", 128), /UTF-8|BOM|NUL/u);
  }
});

test(
  "public portable check and doctor reject FIFO adoption input without recovery state",
  {
    skip:
      process.platform === "win32"
        ? "POSIX FIFO observation; Windows regular-file cases run above"
        : false,
  },
  async (t) => {
    const root = await fixture(t);
    await fs.cp(new URL("./fixtures/portable-qualification", import.meta.url), root, {
      recursive: true,
    });
    const agents = join(root, "AGENTS.md");
    await fs.rm(agents);
    const fifo = spawnSync("mkfifo", [agents], { encoding: "utf8" });
    assert.equal(fifo.status, 0, fifo.stderr);
    const before = (await fs.readdir(root)).toSorted();
    for (const command of ["docsCheckV2", "docsDoctorV2"]) {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
      const api = await import(process.argv[1]);
      const result = await api[process.argv[3]]({ consumerRoot: process.argv[2], profilePath: 'docs.config.yaml' });
      console.log(JSON.stringify(result));
    `,
          new URL("../dist/index.js", import.meta.url).href,
          root,
          command,
        ],
        {
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      assert.equal(result.error, undefined, `${command} must terminate: ${String(result.error)}`);
      assert.equal(result.status, 0, result.stderr);
      const observed: unknown = JSON.parse(result.stdout);
      assert.ok(typeof observed === "object" && observed !== null && "envelope" in observed);
      const envelope = observed.envelope;
      assert.ok(typeof envelope === "object" && envelope !== null && "outcome" in envelope);
      assert.equal(envelope.outcome, "violation");
      assert.match(result.stdout, /docs\.adoption\.invalid/u);
    }
    assert.deepEqual((await fs.readdir(root)).toSorted(), before);
    assert.equal((await fs.lstat(agents)).isFIFO(), true);
  },
);
