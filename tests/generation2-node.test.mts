import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GENERATION2_NODE_ENV, generation2Minor, resolveGeneration2Node } from "../scripts/generation2-node.mts";

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
