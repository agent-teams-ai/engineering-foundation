import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const fixtures = join(packageRoot, "tests/fixtures/public-api");

async function materializeConsumerSources(consumerRoot) {
  // Preserve the reviewed installed-consumer bytes, including recovery probes.
  for (const name of ["consumer.ts", "runtime-consumer.mjs"]) {
    const bytes = await readFile(join(fixtures, `${name}.txt`));
    const destination = join(consumerRoot, name);
    await writeFile(destination, bytes, { flag: "wx" });
    assert.deepEqual(await readFile(destination), bytes);
  }
  await cp(join(fixtures, "crash-worker.mjs"), join(consumerRoot, "crash-worker.mjs"));
}

async function linkDependency(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await symlink(await realpath(source), destination, process.platform === "win32" ? "junction" : "dir");
}

async function copyInstalledPackage(sourceRoot, targetRoot) {
  await mkdir(targetRoot, { recursive: true });
  const archive = `${targetRoot}.tgz`;
  const packed = spawnSync("pnpm", ["pack", "--out", archive], {
    cwd: sourceRoot, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, COREPACK_HOME: process.env.COREPACK_HOME ?? "/tmp/ef-corepack",
      pnpm_config_verify_deps_before_run: "false" },
    shell: process.platform === "win32"
  });
  assert.equal(packed.error, undefined, packed.error?.message);
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  const extracted = spawnSync("tar", ["-xzf", archive, "--strip-components=1", "-C", targetRoot], {
    encoding: "utf8", timeout: 30_000
  });
  assert.equal(extracted.error, undefined, extracted.error?.message);
  assert.equal(extracted.status, 0, extracted.stdout + extracted.stderr);
  const manifest = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (name === "@agent-teams/repository-mutation") { continue; }
    await linkDependency(join(sourceRoot, "node_modules", name), join(targetRoot, "node_modules", name));
  }
}

async function materializeInstalledConsumer(t) {
  const consumerRoot = await realpath(await mkdtemp(join(tmpdir(), "document-authoring-api-consumer-")));
  t.after(() => rm(consumerRoot, { force: true, recursive: true }));
  const scopeRoot = join(consumerRoot, "node_modules", "@agent-teams");
  // Install real packed archives and their schemas under real export maps.
  // Only external, already pinned dependencies link to the coordinator's install.
  // Registry/package-publication qualification remains a separate gate.
  await Promise.all([
    copyInstalledPackage(packageRoot, join(scopeRoot, "document-authoring")),
    copyInstalledPackage(join(repositoryRoot, "packages/repository-mutation"), join(scopeRoot, "repository-mutation")),
    linkDependency(join(repositoryRoot, "node_modules/@types/node"), join(consumerRoot, "node_modules/@types/node")),
    materializeConsumerSources(consumerRoot),
    cp(join(repositoryRoot, "tests/support/document-authoring-schema-closures.mjs"), join(consumerRoot, "schema-closures.mjs")),
    cp(join(repositoryRoot, "tests/support/historical-schema-fixtures.mjs"), join(consumerRoot, "historical-schema-fixtures.mjs")),
    cp(join(repositoryRoot, "tests/support/historical-schemas"), join(consumerRoot, "historical-schemas"), { recursive: true }),
    cp(join(packageRoot, "tests/fixtures/schema-recovery"), join(consumerRoot, "native"), { recursive: true }),
    linkDependency(join(packageRoot, "node_modules/ajv"), join(consumerRoot, "node_modules/ajv")),
    writeFile(join(consumerRoot, "package.json"), JSON.stringify({
      name: "document-authoring-public-api-consumer", private: true, type: "module"
    }))
  ]);
  return consumerRoot;
}

function runNode(consumerRoot, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: consumerRoot, encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout;
}

test("installed consumer compiles truthful v1/v2 authoring contracts", async (t) => {
  const consumerRoot = await materializeInstalledConsumer(t);
  await writeFile(join(consumerRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      exactOptionalPropertyTypes: true, module: "NodeNext", moduleResolution: "NodeNext",
      noEmit: true, strict: true, target: "ES2024", types: ["node"], verbatimModuleSyntax: true
    },
    include: ["consumer.ts"]
  }));
  runNode(consumerRoot, [join(repositoryRoot, "node_modules/typescript/bin/tsc"),
    "--project", join(consumerRoot, "tsconfig.json"), "--pretty", "false"]);
});

test("installed consumer plans both generations without mutation", async (t) => {
  const consumerRoot = await materializeInstalledConsumer(t);
  for (const [generation, entrypoint] of [[1, "generic"], [2, "generic"], [2, "V2"]]) {
    await t.test(`v${generation} ${entrypoint} plan`, async () => {
      await runRuntimeCase(consumerRoot, { generation, entrypoint, operation: "plan" });
    });
  }
});

async function runRuntimeCase(consumerRoot, { generation, entrypoint, operation, checkpoint }) {
  const root = join(consumerRoot, `v${generation}-${entrypoint}-${operation}-${checkpoint ?? "none"}`);
  await cp(join(repositoryRoot, "tests/fixtures/document-planning/orchestrator"), root, { recursive: true });
  const output = runNode(consumerRoot, [join(consumerRoot, "runtime-consumer.mjs"),
    root, String(generation), entrypoint, operation, ...(checkpoint === undefined ? [] : [checkpoint])]);
  assert.deepEqual(JSON.parse(output), { generation, entrypoint, operation, outcome: "passed" });
}

test("installed JavaScript consumer rejects v1 at explicit V2 admission", async (t) => {
  const consumerRoot = await materializeInstalledConsumer(t);
  await runRuntimeCase(consumerRoot, { generation: 1, entrypoint: "V2", operation: "reject-v1" });
});

test("installed consumer applies, replays and recovers exact v1/v2 receipts", {
  skip: process.platform === "win32" ? "Document writer requires strict POSIX directory durability." : false
}, async (t) => {
  const consumerRoot = await materializeInstalledConsumer(t);
  for (const generation of [1, 2]) {
    for (const entrypoint of ["generic", "V2"]) {
      // Explicit V2 apply accepts only v2; its recovery name accepts both.
      if (generation === 2 || entrypoint === "generic") {
        await t.test(`v${generation} ${entrypoint} apply/replay`, async () => {
          await runRuntimeCase(consumerRoot, { generation, entrypoint, operation: "apply" });
        });
      }
      for (const checkpoint of ["after-publishing-journal-durable", "after-published-journal-durable"]) {
        await t.test(`v${generation} ${entrypoint} recover ${checkpoint}`, async () => {
          await runRuntimeCase(consumerRoot, { generation, entrypoint, operation: "recover", checkpoint });
        });
      }
    }
  }
});

test("same-version changed Authoring or Mutation archive bytes refuse recovery", {
  skip: process.platform === "win32" ? "Document writer requires strict POSIX directory durability." : false
}, async (t) => {
  const consumerRoot = await materializeInstalledConsumer(t);
  for (const generation of [1, 2]) {
    for (const checkpoint of ["document-authoring", "repository-mutation"]) {
      await t.test(`v${generation} changed ${checkpoint}`, async () => {
        await runRuntimeCase(consumerRoot, {
          generation, entrypoint: "generic", operation: "artifact-drift", checkpoint
        });
      });
    }
  }
});
