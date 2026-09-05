import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export const receiptSubpath = "@agent-teams/repository-mutation/schemas/repository-mutation/known-file-transaction-receipt/v1.schema.json";
export const oldReceiptSubpath = "@agent-teams/repository-mutation/schemas/known-file-transaction-receipt/v1.schema.json";
export const executionKinds = ["integration", "upgrade"];
export const schemaSubpath = (kind, current) =>
  `@agent-teams/docs-protocol-agent-teams/schemas/${current ? "docs-protocol-agent-teams/" : ""}docs-consumer-${kind}-execution/v1.schema.json`;
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const readSchema = async (specifier) => JSON.parse(await readFile(new URL(import.meta.resolve(specifier)), "utf8"));
export const execution = (kind, receipt) => ({
  schemaVersion: 1,
  command: kind === "integration" ? "consumer.apply" : "consumer.upgrade",
  outcome: kind === "integration" ? "applied" : "upgraded",
  issues: [],
  receipt
});

export async function receiptFixtures() {
  const root = new URL("./fixtures/execution-receipts/", import.meta.url);
  const provenance = JSON.parse(await readFile(new URL("provenance.json", root), "utf8"));
  const receipts = {};
  for (const [kind, entry] of Object.entries(provenance.receipts)) {
    const bytes = await readFile(new URL(entry.file, root));
    assert.equal(sha256(bytes), entry.sha256, `${kind} native receipt bytes`);
    receipts[kind] = JSON.parse(bytes.toString("utf8"));
  }
  return receipts;
}

async function linkDirectory(target, path) {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

// Copy real package files into distinct physical installs; only third-party AJV
// uses the preinstalled dependency tree. No workspace link may hide a bad path.
export async function installedExecutionValidator(context, layout, fault) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "managed-execution-install-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const modules = join(root, "node_modules");
  const adapterScope = layout === "npm"
    ? join(modules, "@agent-teams")
    : join(modules, ".pnpm", "@agent-teams+docs-protocol-agent-teams@0.0.0", "node_modules", "@agent-teams");
  const adapter = join(adapterScope, "docs-protocol-agent-teams");
  const mutation = layout === "npm"
    ? join(adapter, "node_modules", "@agent-teams", "repository-mutation")
    : join(modules, ".pnpm", "@agent-teams+repository-mutation@0.0.0", "node_modules", "@agent-teams", "repository-mutation");
  const adapterSource = fileURLToPath(new URL("../", import.meta.url));
  const mutationSource = dirname(fileURLToPath(import.meta.resolve("@agent-teams/repository-mutation/package.json")));
  for (const [source, target] of [[adapterSource, adapter], [mutationSource, mutation]]) {
    for (const member of ["package.json", "dist", "schemas"]) {
      await cp(join(source, member), join(target, member), { recursive: true });
    }
  }
  if (layout === "pnpm") {
    await linkDirectory(adapter, join(modules, "@agent-teams", "docs-protocol-agent-teams"));
    await linkDirectory(mutation, join(adapterScope, "repository-mutation"));
  }
  await linkDirectory(dirname(fileURLToPath(import.meta.resolve("ajv/package.json"))), join(adapter, "node_modules", "ajv"));
  assert.equal(await realpath(adapter), adapter);
  assert.equal(await realpath(mutation), mutation);
  const receiptPath = join(mutation, "schemas/repository-mutation/known-file-transaction-receipt/v1.schema.json");
  const manifestPath = join(mutation, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const exportedKey = "./schemas/repository-mutation/known-file-transaction-receipt/v1.schema.json";
  if (fault === "missing-file") {
    await rm(receiptPath);
  } else if (fault === "unexported") {
    manifest.exports[exportedKey] = null;
  } else if (fault === "wrong-id") {
    const schema = JSON.parse(await readFile(receiptPath, "utf8"));
    schema.$id = "https://agent-teams.ai/schemas/unrelated-receipt/v1";
    await writeFile(receiptPath, JSON.stringify(schema));
  } else if (fault === "relocated-export") {
    await mkdir(join(mutation, "contracts"));
    await cp(receiptPath, join(mutation, "contracts/receipt.json"));
    await rm(receiptPath);
    manifest.exports[exportedKey] = "./contracts/receipt.json";
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  const probe = join(adapter, "execution-schema-probe.mjs");
  await writeFile(probe, `
import * as validators from "./dist/consumer-integration/adapters/consumer-integration-schema-validator.js";
import { createManagedConsumerCommand } from "./dist/consumer-integration/adapters/inbound/consumer-integration-cli.js";
const values = JSON.parse(process.argv[2]);
const results = [];
for (const value of values) {
  try {
    await validators[value.command === "consumer.upgrade" ? "assertConsumerUpgradeExecutionSchema" : "assertConsumerIntegrationExecutionSchema"](value);
    results.push({ valid: true });
  } catch (error) {
    results.push({ valid: false, code: error.code, message: error.message });
  }
}
console.log(JSON.stringify(results));
const command = createManagedConsumerCommand({ apply: async () => values[0], upgrade: async () => values[1] });
const codes = [];
codes.push(await command(["apply", "--expect", "sha256:" + "0".repeat(64), "--json"]));
codes.push(await command(["upgrade", "--to", "schema-test", "--target-generation", "2", "--json"]));
console.log(JSON.stringify(codes));
`);
  return (values) => {
    const result = spawnSync(process.execPath, [probe, JSON.stringify(values)], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const [validation, integration, upgrade, codes] = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    return { validation, integration, upgrade, codes };
  };
}
