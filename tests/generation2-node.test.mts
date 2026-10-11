import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  GENERATION2_LEGACY_TEST_FILES, GENERATION2_NODE_ENV, generation2Minor, partitionGeneration2Tests, resolveGeneration2Node,
} from "../scripts/generation2-node.mts";
import { runPartitionedBuiltTests } from "../scripts/run-built-tests.mjs";
import { runTestShardTests } from "../scripts/run-test-shard.mjs";

// POSIX executable stubs report a Node version, exercising the real child-process probe.
const posix = process.platform !== "win32";

async function stub(root: string, version: string): Promise<string> {
  const path = join(root, `node-${version}`);
  await writeFile(path, `#!/bin/sh\necho v${version}\n`);
  await chmod(path, 0o755);
  return path;
}

test("generation2 version output accepts one LF or CRLF terminated Node 24.18+ line only", () => {
  for (const output of ["v24.21.0", "v24.21.0\n", "v24.21.0\r\n", "v24.18.0\r\n"]) {
    assert.equal(generation2Minor(output) !== undefined, true, JSON.stringify(output));
  }
  assert.equal(generation2Minor("v24.21.0\r\n"), 21);
  for (const output of ["v24.17.9\r\n", "v26.11.1\r\n", "v25.0.0\n", "v240.21.0\n", "v24.21.0\r\r\n",
    "v24.21.0\n\n", "v24.21.0\r\nv24.21.0\r\n", "v24.21.0\nx", " v24.21.0\n", "v24.21.0-rc.1\n", ""]) {
    const minor = generation2Minor(output);
    assert.equal(minor === undefined || minor < 18, true, JSON.stringify(output));
  }
});

test("generation2 consumer gates accept a CRLF-reporting Node 24 and reject multiline output", { skip: !posix }, async context => {
  const root = await mkdtemp(join(tmpdir(), "generation2-node-crlf-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const write = async (name: string, body: string): Promise<string> => {
    const path = join(root, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  };
  const crlf = await write("crlf", "printf 'v24.21.0\\r\\n'");
  assert.equal(await resolveGeneration2Node({ [GENERATION2_NODE_ENV]: crlf }, "/unused"), crlf);
  const multiline = await write("multiline", "printf 'v24.21.0\\nv26.11.1\\n'");
  await assert.rejects(resolveGeneration2Node({ [GENERATION2_NODE_ENV]: multiline }, "/unused"), /require Node >=24\.18\.0 <25/u);
});

test("legacy generation2 suites are partitioned out of the default interpreter", () => {
  const legacy = GENERATION2_LEGACY_TEST_FILES;
  assert.equal(legacy.length, 3);
  const mixed = ["tests/other.test.mjs", ...legacy, "tests/another.test.mts"];
  assert.deepEqual(partitionGeneration2Tests(mixed), {
    current: ["tests/other.test.mjs", "tests/another.test.mts"], legacy: [...legacy],
  });
  assert.deepEqual(partitionGeneration2Tests(legacy.map(file => file.replaceAll("/", "\\"))).current, []);
});

test("the shard runner launches legacy generation2 suites only through the explicit Node 24", { skip: !posix }, async context => {
  const root = await mkdtemp(join(tmpdir(), "generation2-shard-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const legacyFile = GENERATION2_LEGACY_TEST_FILES[0]!;
  await mkdir(join(root, dirname(legacyFile)), { recursive: true });
  await mkdir(join(root, "architecture", "foundation"), { recursive: true });
  await writeFile(join(root, legacyFile), "throw new Error('must run only through the stub interpreter');\n");
  await writeFile(join(root, "current.test.mjs"), 'import test from "node:test"; test("current", () => {});\n');
  await writeFile(join(root, "required.test.mjs"), 'import test from "node:test"; test("required", () => {});\n');
  await writeFile(join(root, "architecture", "foundation", "node-test-execution.json"), JSON.stringify({
    schemaVersion: 1, required: [{ file: "required.test.mjs", names: ["required"], kind: "test" }], exceptions: [],
  }));
  const log = join(root, "launches.log");
  const interpreter = async (name: string, version: string): Promise<string> => {
    const path = join(root, name);
    await writeFile(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${version}; exit 0; fi\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`);
    await chmod(path, 0o755);
    return path;
  };
  const previous = process.env[GENERATION2_NODE_ENV];
  context.after(() => { if (previous === undefined) { delete process.env[GENERATION2_NODE_ENV]; } else { process.env[GENERATION2_NODE_ENV] = previous; } });
  process.env[GENERATION2_NODE_ENV] = await interpreter("node24", "24.21.0");
  assert.equal(await runTestShardTests([legacyFile, "current.test.mjs"], {}, root), 0);
  const launches = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(launches.length, 1, "only the legacy suite uses the explicit interpreter");
  assert.match(launches[0]!, new RegExp(`--test .*${legacyFile.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u"));
  assert.doesNotMatch(launches[0]!, /current\.test\.mjs/u);
  process.env[GENERATION2_NODE_ENV] = await interpreter("node26", "26.11.1");
  await assert.rejects(runTestShardTests([legacyFile], {}, root), /require Node >=24\.18\.0 <25/u);
});

test("the built-test runner sends only legacy generation2 suites to the explicit Node 24 and resolves it first", { skip: !posix }, async context => {
  const root = await mkdtemp(join(tmpdir(), "generation2-built-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const log = join(root, "launches.log");
  const interpreter = async (version: string): Promise<string> => {
    const path = join(root, `node-${version}`);
    await writeFile(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${version}; exit 0; fi\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`);
    await chmod(path, 0o755);
    return path;
  };
  const previous = process.env[GENERATION2_NODE_ENV];
  context.after(() => { if (previous === undefined) { delete process.env[GENERATION2_NODE_ENV]; } else { process.env[GENERATION2_NODE_ENV] = previous; } });
  const launched: { node: string; tests: string[] }[] = [];
  const spawnChild = (node: string, args: string[]): EventEmitter & { kill: () => void } => {
    launched.push({ node, tests: args.slice(2) });
    const child = Object.assign(new EventEmitter(), { kill: () => undefined });
    setImmediate(() => child.emit("exit", node === process.execPath ? currentExit : 0, null));
    return child;
  };
  let currentExit = 0;
  const legacy = [...GENERATION2_LEGACY_TEST_FILES];
  const tests = ["tests/a.test.mjs", ...legacy, "tests/b.test.mjs"];
  const mandatorySeen: string[][] = [];
  const runMandatory = async (files: string[]): Promise<null> => { mandatorySeen.push(files); return null; };
  const node24 = process.env[GENERATION2_NODE_ENV] = await interpreter("24.21.0");
  assert.equal(await runPartitionedBuiltTests(tests, { spawnChild, runMandatory }), 0);
  assert.deepEqual(mandatorySeen, [["tests/a.test.mjs", "tests/b.test.mjs"]]);
  assert.deepEqual(launched, [
    { node: process.execPath, tests: ["tests/a.test.mjs", "tests/b.test.mjs"] },
    { node: node24, tests: legacy },
  ]);
  // A failing current lane must not suppress the legacy lane, and its exit code is preserved.
  launched.length = 0; currentExit = 7;
  assert.equal(await runPartitionedBuiltTests(tests, { spawnChild, runMandatory }), 7);
  assert.deepEqual(launched.map(({ node }) => node), [process.execPath, node24]);
  currentExit = 0;
  // An unavailable Node 24 fails before any suite, mandatory observation included, starts.
  launched.length = 0; mandatorySeen.length = 0;
  process.env[GENERATION2_NODE_ENV] = await interpreter("26.11.1");
  await assert.rejects(runPartitionedBuiltTests(tests, { spawnChild, runMandatory }), /require Node >=24\.18\.0 <25/u);
  assert.deepEqual([launched, mandatorySeen], [[], []]);
});

test("generation2 consumer gates fail closed outside Node >=24.18.0 <25", { skip: !posix }, async context => {
  const root = await mkdtemp(join(tmpdir(), "generation2-node-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const version of ["24.21.0", "24.18.0"]) {
    const node = await stub(root, version);
    assert.equal(await resolveGeneration2Node({ [GENERATION2_NODE_ENV]: node }, "/unused"), node);
  }
  for (const version of ["26.11.1", "24.17.9", "25.0.0"]) {
    const node = await stub(root, version);
    await assert.rejects(resolveGeneration2Node({ [GENERATION2_NODE_ENV]: node }, "/unused"), /require Node >=24\.18\.0 <25/u);
  }
  await assert.rejects(resolveGeneration2Node({ [GENERATION2_NODE_ENV]: "node" }, "/unused"), /absolute/u);
  // Without an explicit Node 24, the current process is used and judged by its real version.
  const outcome = resolveGeneration2Node({}, process.execPath);
  if (/^24\.(?:1[89]|[2-9]\d)\./u.test(process.versions.node)) { assert.equal(await outcome, process.execPath); }
  else { await assert.rejects(outcome, /require Node >=24\.18\.0 <25/u); }
});
