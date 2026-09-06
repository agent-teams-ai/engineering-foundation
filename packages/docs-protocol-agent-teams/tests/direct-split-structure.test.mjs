import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const adapterRoot = new URL("..", import.meta.url).pathname;
const packagesRoot = dirname(adapterRoot);
const coreRoot = join(packagesRoot, "docs-protocol");
const repositoryMutationRoot = join(packagesRoot, "repository-mutation");
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
  assert.equal(adapterManifest.dependencies["@agent-teams/repository-mutation"], "workspace:*");

  const runner = await readFile(join(adapterRoot, "src/qualification/adapters/outbound/node-managed-qualification.ts"), "utf8");
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
    ["docs-protocol-agent-teams", adapterRoot],
    ["repository-mutation", repositoryMutationRoot]
  ]);
  t.after(() => rm(managed, { recursive: true, force: true }));
  const managedRequire = createRequire(join(managed, "entry.cjs"));
  assert.equal(await realpath(managedRequire.resolve("@agent-teams/docs-protocol-agent-teams/package.json")),
    await realpath(join(adapterRoot, "package.json")));
  assert.equal(await realpath(managedRequire.resolve("@agent-teams/repository-mutation/package.json")),
    await realpath(join(repositoryMutationRoot, "package.json")));

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
    "src/qualification/adapters/outbound/node-managed-qualification.ts"
  ];
  const source = (await Promise.all(sourceFiles.map((path) => readFile(join(adapterRoot, path), "utf8")))).join("\n");
  assert.match(source, /KnownFileTransaction|known-file|journal/iu);
  assert.match(source, /rollback|recover/iu);
  assert.match(source, /AbortSignal|throwIfAborted|aborted/iu);
  assert.match(source, /symbolic|symlink|O_NOFOLLOW/iu);
  assert.match(source, /nlink|hardlink/iu);
  assert.match(source, /normalize\("NFC"\)|NFC/iu);
  assert.match(source, /@agent-teams\/repository-mutation/iu);
  assert.doesNotMatch(source, /@agent-teams\/engineering-foundation\/mutation/iu);
});

test("managed publication uses the repository-mutation transaction owner", async () => {
  const transactionAdapter = await readFile(join(
    adapterRoot,
    "src/consumer-integration/adapters/foundation-known-file-transaction.ts"
  ), "utf8");
  assert.doesNotMatch(transactionAdapter, /@agent-teams\/repository-mutation/u);
  const composition = await readFile(join(
    adapterRoot,
    "src/consumer-integration/composition/known-file-transaction.ts"
  ), "utf8");
  assert.match(composition, /applyKnownFileTransaction/u);
  assert.match(composition, /inspectKnownFileTransactionBarrier/u);
  assert.match(composition, /recoverKnownFileTransaction/u);
  assert.match(composition, /from "@agent-teams\/repository-mutation"/u);
  assert.doesNotMatch(transactionAdapter, /@agent-teams\/engineering-foundation\/mutation/u);
});


test("transaction bridge projects only managed authority and defers execution", async () => {
  const { createFoundationKnownFileTransaction } = await import(
    "../dist/consumer-integration/adapters/foundation-known-file-transaction.js"
  );
  const calls = [];
  let observation = { state: "idle", privateJournal: "/private/journal" };
  const receipt = Object.freeze({ receiptDigest: "opaque fixture receipt" });
  const operations = {
    calls,
    receipt,
    async inspect(options) { this.calls.push(["inspect", options]); return observation; },
    async apply(options) { this.calls.push(["apply", options]); return this.receipt; },
    async recover(options) { this.calls.push(["recover", options]); return this.receipt; }
  };
  const bridge = createFoundationKnownFileTransaction(operations);
  assert.deepEqual(calls, []);
  const options = { consumerRoot: "/unused-disposable-fixture" };
  assert.deepEqual(await bridge.inspect(options), { state: "idle" });
  observation = { state: "recovery-required", code: "KNOWN_FILE_RECOVERY_REQUIRED",
    message: "Recover the recorded owner", privateJournal: "/private/journal" };
  const projected = await bridge.inspect(options);
  assert.deepEqual(projected, { state: observation.state, code: observation.code, message: observation.message });
  assert.ok(Object.isFrozen(projected));
  assert.equal(await bridge.apply(options), receipt);
  assert.equal(await bridge.recover(options), receipt);
  assert.deepEqual(calls.map(([operation]) => operation), ["inspect", "inspect", "apply", "recover"]);
  for (const [, actual] of calls) { assert.equal(actual, options); }
});

test("managed public assembly enumerates its supported exports", async () => {
  const source = await readFile(join(adapterRoot, "src/index.ts"), "utf8");
  assert.doesNotMatch(source, /export\s+\*/u);
});

test("managed application owns the barrier observation used by its lifecycle port", async () => {
  const source = await readFile(join(adapterRoot,
    "src/consumer-integration/application/ports/consumer-integration-lifecycle.ts"), "utf8");
  assert.doesNotMatch(source, /KnownFileTransactionBarrierInspection/u);
});


test("managed root retains every existing runtime and type export", async () => {
  const expected = JSON.parse(await readFile(new URL("./fixtures/managed-public-surface.json", import.meta.url), "utf8"));
  const actual = await import("../dist/index.js");
  assert.deepEqual(Object.keys(actual).toSorted(), expected.runtime);
  const source = await readFile(join(adapterRoot, "src/index.ts"), "utf8");
  const declared = [...source.matchAll(/export(?:\s+type)?\s*\{([^}]+)\}/gu)]
    .flatMap((match) => match[1].split(",").map((name) => name.trim()).filter(Boolean)).toSorted();
  assert.deepEqual(declared, expected.all);
});

function unexpectedAuthorityRead() {
  throw new Error("Authority must not be read while recovery is required.");
}

test("managed lifecycle uses the supplied barrier before reading authority and recovers without a profile", async () => {
  const { createConsumerIntegrationUseCases } = await import("../dist/consumer-integration/application-api.js");
  for (const code of ["KNOWN_FILE_OPERATION_ACTIVE", "KNOWN_FILE_RECOVERY_REQUIRED"]) {
    const observed = [];
    const receipt = { outcome: "already-satisfied", receiptDigest: `sha256:${"1".repeat(64)}` };
    const useCases = createConsumerIntegrationUseCases({
      input: { read: unexpectedAuthorityRead },
      assets: { read: unexpectedAuthorityRead },
      planning: {},
      transaction: {
        async inspect(options) {
          observed.push(options);
          return { state: "recovery-required", code, message: "Preserve exact owner evidence." };
        },
        apply: unexpectedAuthorityRead,
        async recover(options) { observed.push(options); return receipt; }
      }
    });
    for (const [command, options] of [
      ["check", { consumerRoot: "opaque-root" }],
      ["plan", { consumerRoot: "opaque-root", to: "next-cohort" }],
      ["apply", { consumerRoot: "opaque-root", expect: `sha256:${"2".repeat(64)}` }]
    ]) {
      const result = await useCases[command](options);
      assert.equal(result.outcome, "blocked");
      assert.deepEqual(result.issues, [{ code, severity: "error", subject: "foundation-transaction", message: "Preserve exact owner evidence." }]);
    }
    const recovered = await useCases.recover({ consumerRoot: "opaque-root" });
    assert.equal(recovered.outcome, "recovered");
    assert.strictEqual(recovered.receipt, receipt);
    assert.deepEqual(observed, Array.from({ length: 4 }, () => ({ consumerRoot: "opaque-root" })));
  }
});

test("managed inbound dispatch uses the composed commands and preserves argument boundaries", async () => {
  const { createManagedDocsCli } = await import("../dist/consumer-integration/adapters/inbound/managed-cli.js");
  const calls = [];
  const run = createManagedDocsCli({
    async consumer(values) { calls.push(["consumer", values]); return 3; },
    async qualification(values) { calls.push(["qualification", values]); return 130; }
  });
  assert.equal(await run(["--", "qualify", "--json"]), 130);
  assert.equal(await run(["plan", "--to", "cohort"]), 3);
  assert.deepEqual(calls, [["qualification", ["--json"]], ["consumer", ["plan", "--to", "cohort"]]]);
});


test("managed planner composition does not own generation validation or manifest dispatch", async () => {
  const source = await readFile(join(adapterRoot,
    "src/consumer-integration/composition/consumer-integration-planner.ts"), "utf8");
  assert.doesNotMatch(source, /switch\s*\(|throw new TypeError/u);
});
