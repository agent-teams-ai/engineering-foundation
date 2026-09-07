import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const fixtures = join(packageRoot, "tests/fixtures/public-api");

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024, ...options
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

test("packed Mutation consumer compiles, applies, replays and recovers through public exports", async (t) => {
  const consumerRoot = await realpath(await mkdtemp(join(tmpdir(), "repository-mutation-api-consumer-")));
  t.after(() => rm(consumerRoot, { force: true, recursive: true }));
  const installed = join(consumerRoot, "node_modules/@agent-teams/repository-mutation");
  await mkdir(installed, { recursive: true });
  const archive = join(consumerRoot, "repository-mutation.tgz");
  run("pnpm", ["pack", "--out", archive], packageRoot, {
    timeout: 60_000,
    env: { ...process.env, COREPACK_HOME: process.env.COREPACK_HOME ?? "/tmp/ef-corepack",
      pnpm_config_verify_deps_before_run: "false" },
    shell: process.platform === "win32"
  });
  run("tar", ["-xzf", archive, "--strip-components=1", "-C", installed], consumerRoot, { timeout: 30_000 });
  const types = join(consumerRoot, "node_modules/@types/node");
  await mkdir(dirname(types), { recursive: true });
  await symlink(await realpath(join(repositoryRoot, "node_modules/@types/node")), types,
    process.platform === "win32" ? "junction" : "dir");
  for (const name of ["consumer.ts", "runtime-consumer.mjs"]) {
    const bytes = await readFile(join(fixtures, `${name}.txt`));
    await writeFile(join(consumerRoot, name), bytes, { flag: "wx" });
    assert.deepEqual(await readFile(join(consumerRoot, name)), bytes);
  }
  await writeFile(join(consumerRoot, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await writeFile(join(consumerRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      exactOptionalPropertyTypes: true, module: "NodeNext", moduleResolution: "NodeNext",
      noEmit: true, strict: true, target: "ES2024", types: ["node"], verbatimModuleSyntax: true
    },
    include: ["consumer.ts"]
  }));
  run(process.execPath, [join(repositoryRoot, "node_modules/typescript/bin/tsc"),
    "--project", join(consumerRoot, "tsconfig.json"), "--pretty", "false"], consumerRoot);
  const output = run(process.execPath, [join(consumerRoot, "runtime-consumer.mjs"),
    join(consumerRoot, "workspace")], consumerRoot);
  assert.deepEqual(JSON.parse(output), { outcome: "passed", platform: process.platform });
});
