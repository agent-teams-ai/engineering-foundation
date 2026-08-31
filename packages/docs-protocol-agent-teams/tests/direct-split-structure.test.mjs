import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const adapterRoot = new URL("..", import.meta.url).pathname;
const packagesRoot = dirname(adapterRoot);
const coreRoot = join(packagesRoot, "docs-protocol");
const adapterManifest = JSON.parse(await readFile(join(adapterRoot, "package.json"), "utf8"));

async function disposableInstall(packages) {
  const root = await mkdtemp(join(tmpdir(), "docs-direct-split-"));
  const scope = join(root, "node_modules", "@agent-teams");
  await mkdir(scope, { recursive: true });
  for (const [name, target] of packages) {
    await symlink(target, join(scope, name), process.platform === "win32" ? "junction" : "dir");
  }
  return root;
}

test("adapter alone owns the managed command and depends on the core public package", async () => {
  assert.deepEqual(adapterManifest.bin, {
    "agent-teams-docs-managed": "./dist/cli.js"
  });
  assert.equal(adapterManifest.bin["agent-teams-docs"], undefined);
  assert.equal(adapterManifest.dependencies["@agent-teams/docs-protocol"], "workspace:*");

  const runner = await readFile(join(adapterRoot, "src/qualification/qualification-v2-runner.ts"), "utf8");
  assert.match(runner, /from "@agent-teams\/docs-protocol";/u);
  assert.match(runner, /from "@agent-teams\/docs-protocol\/qualification";/u);
  assert.doesNotMatch(runner, /docs-protocol\/(?:src|dist)\//u);
});

test("direct portable and managed install graphs resolve without duplicate implementation", async (t) => {
  const portable = await disposableInstall([["docs-protocol", coreRoot]]);
  t.after(() => rm(portable, { recursive: true, force: true }));
  const portableRequire = createRequire(join(portable, "entry.cjs"));
  assert.equal(await realpath(portableRequire.resolve("@agent-teams/docs-protocol/package.json")),
    await realpath(join(coreRoot, "package.json")));
  assert.throws(() => portableRequire.resolve("@agent-teams/docs-protocol-agent-teams/package.json"),
    { code: "MODULE_NOT_FOUND" });

  const managed = await disposableInstall([
    ["docs-protocol", coreRoot],
    ["docs-protocol-agent-teams", adapterRoot]
  ]);
  t.after(() => rm(managed, { recursive: true, force: true }));
  const managedRequire = createRequire(join(managed, "entry.cjs"));
  assert.equal(await realpath(managedRequire.resolve("@agent-teams/docs-protocol-agent-teams/package.json")),
    await realpath(join(adapterRoot, "package.json")));

  let portableManagedSources = [];
  try {
    portableManagedSources = (await readdir(join(coreRoot, "src", "consumer-integration"), {
      recursive: true
    })).filter((path) => path.endsWith(".ts"));
  } catch (error) {
    if (error?.code !== "ENOENT") {throw error;}
  }
  assert.deepEqual(portableManagedSources, []);
});

test("managed implementation retains fail-closed transaction boundaries", async () => {
  const sourceFiles = [
    "src/consumer-integration/adapters/foundation-known-file-transaction.ts",
    "src/consumer-integration/adapters/node-consumer-integration-repository.ts",
    "src/consumer-integration/adapters/node-consumer-upgrade-sandbox.ts",
    "src/consumer-integration/adapters/bounded-repository-topology.ts",
    "src/consumer-integration/adapters/agents-route-adapter-v1.ts",
    "src/qualification/qualification-v2-runner.ts"
  ];
  const source = (await Promise.all(sourceFiles.map((path) => readFile(join(adapterRoot, path), "utf8")))).join("\n");
  assert.match(source, /KnownFileTransaction|known-file|journal/iu);
  assert.match(source, /rollback|recover/iu);
  assert.match(source, /AbortSignal|throwIfAborted|aborted/iu);
  assert.match(source, /symbolic|symlink|O_NOFOLLOW/iu);
  assert.match(source, /nlink|hardlink/iu);
  assert.match(source, /normalize\("NFC"\)|NFC/iu);
  assert.match(source, /@agent-teams\/engineering-foundation\/mutation/iu);
});

test("managed publication keeps the Foundation Windows read-only transaction policy", async () => {
  const transactionAdapter = await readFile(join(
    adapterRoot,
    "src/consumer-integration/adapters/foundation-known-file-transaction.ts"
  ), "utf8");
  assert.match(transactionAdapter, /applyKnownFileTransaction/u);
  assert.match(transactionAdapter, /inspectKnownFileTransactionBarrier/u);
  assert.match(transactionAdapter, /recoverKnownFileTransaction/u);
  assert.match(transactionAdapter, /from "@agent-teams\/engineering-foundation\/mutation"/u);
});
