import { spawn } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  captureFailure,
  createPnpmRunner,
  runCommand
} from "./pack-test-support.mjs";
import { writePackedConsumerDocumentAuthoringFixture } from "./packed-consumer-document-authoring-fixture.mjs";

const packageName = "@agent-teams/engineering-foundation";
const timeoutMs = 120_000;
const runPnpm = createPnpmRunner();

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

async function jsonCommand(consumerRoot, args, expectedExitCode = 0) {
  const execution = expectedExitCode === 0
    ? await runBin(consumerRoot, [...args, "--json"])
    : await captureFailure(() => runBin(consumerRoot, [...args, "--json"]));
  if (expectedExitCode !== 0) {
    assert(execution?.code === expectedExitCode,
      `JSON document command exited with ${execution?.code ?? "no failure"}; expected ${expectedExitCode}.`);
  }
  const { stderr, stdout } = execution;
  assert(stderr === "", "JSON document command wrote unexpected stderr output.");
  const lines = stdout.trim().split(/\r?\n/u);
  assert(lines.length === 1, "JSON document command did not write exactly one envelope.");
  return JSON.parse(lines[0]);
}

async function jsonAliasCommand(consumerRoot, alias, args) {
  const { stderr, stdout } = await runPnpm([
    "--silent", "run", alias, "--", ...args, "--json"
  ], consumerRoot);
  assert(stderr === "", `${alias} wrote unexpected stderr output.`);
  const lines = stdout.trim().split(/\r?\n/u);
  assert(lines.length === 1, `${alias} did not write exactly one JSON envelope.`);
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
  return documentArgs(consumerRoot, {
    dryRun,
    id: "ADR-0042",
    slug: "packed-registry-boundary",
    title: "Packed Registry Boundary"
  });
}

function documentArgs(consumerRoot, input) {
  return [
    "docs", "new", "--type", "adr", "--id", input.id,
    "--title", input.title, "--owner", "architecture",
    "--summary", "Proves deterministic authoring from a clean registry install.",
    "--slug", input.slug, "--consumer", consumerRoot,
    "--profile", "architecture/foundation/document-authoring.yaml",
    ...(input.dryRun === true ? ["--dry-run"] : [])
  ];
}

export async function verifyRegistryDocumentAuthoring(input) {
  await assertInstalledBoundary(input);
  await writePackedConsumerDocumentAuthoringFixture(input.consumerRoot);

  await assertConsumerAliases(input.consumerRoot);
  await assertPreview(input.consumerRoot);
  await assertIdleCommands(input.consumerRoot);
  if (process.platform !== "win32") {
    await assertApplyAndReplay(input.consumerRoot);
    await assertCrashRecovery(input.consumerRoot);
  }
}

async function assertConsumerAliases(consumerRoot) {
  const manifest = JSON.parse(await readFile(join(consumerRoot, "package.json"), "utf8"));
  const expected = {
    "docs:find": "agent-teams-foundation docs find",
    "docs:new": "agent-teams-foundation docs new",
    "docs:doctor": "agent-teams-foundation docs doctor",
    check: "agent-teams-foundation repo check"
  };
  assert(JSON.stringify(manifest.scripts) === JSON.stringify(expected),
    "Disposable consumer does not expose the canonical Node/pnpm aliases.");
  const found = await jsonAliasCommand(consumerRoot, "docs:find", [
    "Hermetic", "--consumer", consumerRoot
  ]);
  assert(found.command === "docs.find" && found.outcome === "success" &&
    found.result?.matches?.length === 1,
  "pnpm docs:find did not execute the installed CLI alias.");
  const preview = await jsonAliasCommand(
    consumerRoot,
    "docs:new",
    [
      "--type", "adr", "--id", "ADR-0041", "--title", "Alias",
      "--owner", "architecture", "--summary", "Packed-alias-preview.",
      "--slug", "packed-alias-preview", "--consumer", consumerRoot,
      "--profile", "architecture/foundation/document-authoring.yaml", "--dry-run"
    ]
  );
  assert(preview.command === "docs.new" && preview.result?.writeState === "preview",
    "pnpm docs:new did not execute a non-mutating installed CLI preview.");
  if (process.platform !== "win32") {
    const doctor = await jsonAliasCommand(consumerRoot, "docs:doctor", [
      "--consumer", consumerRoot
    ]);
    assert(doctor.command === "docs.doctor" && doctor.outcome === "success",
      "pnpm docs:doctor did not execute the installed CLI alias.");
  }
}

async function installedPackageRoot(consumerRoot) {
  return realpathSafe(join(
    consumerRoot, "node_modules", "@agent-teams", "engineering-foundation"
  ));
}

async function writeCrashWorker(consumerRoot) {
  const privateWriter = pathToFileURL(join(
    await installedPackageRoot(consumerRoot), "dist", "document-authoring",
    "composition", "node-document-writing-private.js"
  )).href;
  const workerPath = join(consumerRoot, "packed-document-crash-worker.mjs");
  await writeFile(workerPath, [
    'import { readFile } from "node:fs/promises";',
    `import { applyNodeDocumentationPlanPrivately } from ${JSON.stringify(privateWriter)};`,
    "const [consumerRoot, planPath] = process.argv.slice(2);",
    'const plan = JSON.parse(await readFile(planPath, "utf8"));',
    "await applyNodeDocumentationPlanPrivately({ consumerRoot, plan }, {",
    "  faultInjector: async ({ phase }) => {",
    '    if (phase !== "after-publishing-journal-durable") return;',
    '    await new Promise((resolve, reject) => process.stdout.write("CHECKPOINT\\n",',
    "      (error) => error == null ? resolve() : reject(error)));",
    "    await new Promise(() => {});",
    "  }",
    "});",
    ""
  ].join("\n"), "utf8");
  return workerPath;
}

async function crashAtPublishing(consumerRoot, planPath) {
  const child = spawn(process.execPath, [await writeCrashWorker(consumerRoot), consumerRoot, planPath], {
    cwd: consumerRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(
      `Packed writer did not reach durable PUBLISHING: ${stderr}`
    )), 30_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("CHECKPOINT\n")) {
        clearTimeout(deadline);
        resolve();
      }
    });
    child.once("error", (error) => { clearTimeout(deadline); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(deadline);
      reject(new Error(`Packed writer exited before checkpoint: ${code}/${signal}: ${stderr}`));
    });
  });
  assert(child.kill("SIGKILL"), "Packed writer could not be killed at the durable checkpoint.");
  const termination = await exited;
  assert(termination.signal === "SIGKILL",
    `Packed writer did not terminate through SIGKILL: ${termination.code}/${termination.signal}.`);
}

async function compilePackedRecoveryPlan(consumerRoot) {
  const planPath = join(consumerRoot, "packed-recovery-plan.json");
  const scriptPath = join(consumerRoot, "compile-packed-recovery-plan.mjs");
  await writeFile(scriptPath, [
    `import { planDocumentationDocument } from ${JSON.stringify(`${packageName}/document-authoring`)};`,
    'import { writeFile } from "node:fs/promises";',
    "const [consumerRoot, planPath] = process.argv.slice(2);",
    "const plan = await planDocumentationDocument({",
    "  consumerRoot, profilePath: \"architecture/foundation/document-authoring.yaml\",",
    "  intent: { schemaVersion: 1, type: \"adr\", id: \"ADR-0043\",",
    "    title: \"Packed Crash Recovery\", owner: \"architecture\",",
    "    summary: \"Proves deterministic authoring from a clean registry install.\",",
    "    slug: \"packed-crash-recovery\" }",
    "});",
    'await writeFile(planPath, `${JSON.stringify(plan)}\\n`);',
    ""
  ].join("\n"), "utf8");
  await runCommand(process.execPath, [scriptPath, consumerRoot, planPath], consumerRoot, { timeoutMs });
  return { plan: JSON.parse(await readFile(planPath, "utf8")), planPath };
}

async function assertCrashRecovery(consumerRoot) {
  const { plan, planPath } = await compilePackedRecoveryPlan(consumerRoot);
  await crashAtPublishing(consumerRoot, planPath);
  const journalPath = join(consumerRoot, ".agent-teams-local", "scaffolding-transaction.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  assert(journal.schemaVersion === 3 && journal.state === "PUBLISHING" &&
    journal.payloadKind === "document-authoring-journal/v2" &&
    journal.journal?.plan?.planDigest === plan.planDigest,
  "Packed crash did not leave the genuine v3/v2 PUBLISHING transaction for its Plan.");
  const doctor = await jsonCommand(consumerRoot, ["docs", "doctor", "--consumer", consumerRoot], 1);
  assert(doctor.outcome === "recovery-required" &&
    doctor.result?.recoveryClass === "auto-recoverable" &&
    doctor.result?.foundationVersion === plan.compiler.version &&
    doctor.result?.foundationBuildIdentity === plan.compiler.buildIdentity,
  "Packed doctor did not bind recovery to the exact installed version and build.");
  const recovered = await jsonCommand(consumerRoot, ["docs", "recover", "--consumer", consumerRoot]);
  assert(recovered.outcome === "success" && recovered.result?.transactionState === "recovered" &&
    recovered.result?.writeState === "committed",
  "Registry-installed CLI did not recover the genuine durable transaction.");
  const destination = join(consumerRoot, plan.destination);
  const expected = Buffer.from(plan.output.contentBase64, "base64");
  assert((await readFile(destination)).equals(expected), "Recovered document bytes differ from Plan.");
  await assertAbsent(journalPath, "Recovered transaction journal was not removed.");
  const replay = await jsonCommand(consumerRoot, documentArgs(consumerRoot, {
    id: "ADR-0043", slug: "packed-crash-recovery", title: "Packed Crash Recovery"
  }));
  assert(replay.outcome === "success" && replay.result?.writeState === "already-applied",
    "Recovered packed document did not replay as already-applied.");
}

async function assertAbsent(path, message) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(message);
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
  ], process.platform === "win32" ? 1 : 0);
  const expectedDoctorOutcome = process.platform === "win32" ? "violation" : "success";
  const expectedDurability = process.platform === "win32"
    ? "platform-unsupported"
    : "platform-supported";
  assert(doctorBefore.command === "docs.doctor" &&
    doctorBefore.outcome === expectedDoctorOutcome &&
    doctorBefore.result?.transactionState === "none" &&
    doctorBefore.result?.filesystem?.strictDirectoryDurability === expectedDurability,
  "Packed docs doctor did not report the clean consumer platform contract honestly.");
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
