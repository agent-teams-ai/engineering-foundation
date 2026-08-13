import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { runCommand } from "./pack-test-support.mjs";
import { writePackedConsumerDocumentAuthoringFixture } from "./packed-consumer-document-authoring-fixture.mjs";

const packageName = "@agent-teams/engineering-foundation";
const timeoutMs = 120_000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runBin(consumerRoot, args) {
  const binRoot = join(consumerRoot, "node_modules", ".bin");
  if (process.platform === "win32") {
    const bin = join(binRoot, "agent-teams-foundation.cmd");
    await lstat(bin);
    return runCommand(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", bin, ...args],
      consumerRoot, { timeoutMs });
  }
  const bin = join(binRoot, "agent-teams-foundation");
  await lstat(bin);
  return runCommand(bin, args, consumerRoot, { timeoutMs });
}

async function jsonCommand(consumerRoot, args) {
  const { stderr, stdout } = await runBin(consumerRoot, [...args, "--json"]);
  assert(stderr === "", "JSON document command wrote unexpected stderr output.");
  const lines = stdout.trim().split(/\r?\n/u);
  assert(lines.length === 1, "JSON document command did not write exactly one envelope.");
  return JSON.parse(lines[0]);
}

async function assertInstalledBoundary(input) {
  const manifest = JSON.parse(await readFile(join(input.consumerRoot, "package.json"), "utf8"));
  assert(manifest.devDependencies?.[packageName] === input.version,
    "Clean consumer must pin the exact packed Foundation version.");
  const packageRoot = join(input.consumerRoot, "node_modules", "@agent-teams", "engineering-foundation");
  const entry = await lstat(packageRoot);
  assert(entry.isDirectory() && !entry.isSymbolicLink(),
    "Document E2E resolved a workspace/link fallback instead of a registry package.");
  const source = await realpathSafe(packageRoot);
  assert(source.startsWith(await realpathSafe(join(input.consumerRoot, "node_modules"))),
    "Installed Foundation escaped the clean consumer node_modules tree.");
  await runCommand(process.execPath, [
    "--input-type=module", "--eval",
    `const api=await import(${JSON.stringify(`${packageName}/document-authoring`)});if(typeof api.planDocumentationDocument!=="function"||typeof api.applyDocumentationPlan!=="function")process.exit(41);`
  ], input.consumerRoot, { timeoutMs });
}

async function realpathSafe(path) {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}

function newArgs(consumerRoot, dryRun = false) {
  return [
    "docs", "new", "--type", "adr", "--id", "ADR-0042",
    "--title", "Packed Registry Boundary", "--owner", "architecture",
    "--summary", "Proves deterministic authoring from a clean registry install.",
    "--slug", "packed-registry-boundary", "--consumer", consumerRoot,
    "--profile", "architecture/foundation/document-authoring.yaml",
    ...(dryRun ? ["--dry-run"] : [])
  ];
}

export async function verifyRegistryDocumentAuthoring(input) {
  await assertInstalledBoundary(input);
  await writePackedConsumerDocumentAuthoringFixture(input.consumerRoot);

  await assertPreview(input.consumerRoot);
  await assertIdleCommands(input.consumerRoot);
  if (process.platform !== "win32") {
    await assertApplyAndReplay(input.consumerRoot);
  }
}

async function assertPreview(consumerRoot) {
  const preview = await jsonCommand(consumerRoot, newArgs(consumerRoot, true));
  assert(preview.command === "docs.new" && preview.outcome === "success" &&
    preview.result?.writeState === "preview",
  "Packed docs new --dry-run did not produce a non-mutating preview.");
  const destination = join(consumerRoot, "docs", "catalog", "0042-packed-registry-boundary.md");
  try {
    await lstat(destination);
    throw new Error("Packed docs new --dry-run mutated the disposable consumer.");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function assertIdleCommands(consumerRoot) {
  const doctorBefore = await jsonCommand(consumerRoot, [
    "docs", "doctor", "--consumer", consumerRoot
  ]);
  assert(doctorBefore.command === "docs.doctor" && doctorBefore.outcome === "success" &&
    doctorBefore.result?.transactionState === "none",
  "Packed docs doctor did not prove the clean consumer starts idle.");
  const recoverBefore = await jsonCommand(consumerRoot, [
    "docs", "recover", "--consumer", consumerRoot
  ]);
  assert(recoverBefore.outcome === "success" &&
    recoverBefore.result?.transactionState === "no-pending-transaction",
  "Packed docs recover was not safe on a clean consumer.");
}

async function assertApplyAndReplay(consumerRoot) {
  const destination = join(consumerRoot, "docs", "catalog", "0042-packed-registry-boundary.md");
  const applied = await jsonCommand(consumerRoot, newArgs(consumerRoot));
  assert(applied.command === "docs.new" && applied.outcome === "success" &&
    applied.result?.writeState === "applied",
  "Packed docs new did not atomically apply the planned document.");
  assert((await readFile(destination, "utf8")).includes("# ADR-0042: Packed Registry Boundary"),
    "Packed docs new wrote unexpected document content.");

  const doctor = await jsonCommand(consumerRoot, [
    "docs", "doctor", "--consumer", consumerRoot
  ]);
  assert(doctor.command === "docs.doctor" && doctor.outcome === "success" &&
    doctor.result?.transactionState === "none",
  "Packed docs doctor did not prove an idle transaction after apply.");

  const recovered = await jsonCommand(consumerRoot, [
    "docs", "recover", "--consumer", consumerRoot
  ]);
  assert(recovered.command === "docs.recover" && recovered.outcome === "success" &&
    recovered.result?.transactionState === "no-pending-transaction",
  "Packed docs recover was not a safe idempotent no-op after commit.");

  const replay = await jsonCommand(consumerRoot, newArgs(consumerRoot));
  assert(replay.outcome === "success" && replay.result?.writeState === "already-applied",
    "Packed docs new exact replay was not deterministic.");
}
