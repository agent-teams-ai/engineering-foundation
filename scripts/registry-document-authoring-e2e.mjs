import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureFailure,
  createPnpmRunner,
  runCommand
} from "./pack-test-support.mjs";
import { writePackedConsumerDocumentAuthoringFixture } from "./packed-consumer-document-authoring-fixture.mjs";
import { verifyWindowsDocsRecoveryQualification } from "./registry-document-authoring-policy.mjs";
import { readInstalledPortableDocsSkill } from "./registry-installed-docs-skill.mjs";
import {
  isCanonicalPathInside,
  isSameCanonicalPath
} from "./registry-package-paths.mjs";

const packageName = "@agent-teams/engineering-foundation", docsPackageName = "@agent-teams/docs-protocol";
const docsProfilePath = "architecture/foundation/docs-protocol.yaml";
const foundationProfilePath = "architecture/foundation/document-authoring.yaml";
const timeoutMs = 120_000, runPnpm = createPnpmRunner();

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

async function runDocsBin(consumerRoot, args) {
  const binRoot = join(consumerRoot, "node_modules", ".bin");
  if (process.platform === "win32") {
    const bin = join(binRoot, "agent-teams-docs.cmd");
    await lstat(bin);
    return runCommand(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", bin, ...args],
      consumerRoot, { timeoutMs });
  }
  const bin = join(binRoot, "agent-teams-docs");
  await lstat(bin);
  return runCommand(bin, args, consumerRoot, { timeoutMs });
}

async function docsJsonCommand(consumerRoot, args, expectedExitCode = 0) {
  const execution = expectedExitCode === 0
    ? await runDocsBin(consumerRoot, [...args, "--json"])
    : await captureFailure(() => runDocsBin(consumerRoot, [...args, "--json"]));
  if (expectedExitCode !== 0) {
    assert(execution?.code === expectedExitCode,
      `Docs Protocol command exited with ${execution?.code ?? "no failure"}; expected ${expectedExitCode}.`);
  }
  assert(execution.stderr === "", "Docs Protocol JSON command wrote unexpected stderr output.");
  const lines = execution.stdout.trim().split(/\r?\n/u);
  assert(lines.length === 1, "Docs Protocol command did not write exactly one JSON envelope.");
  return JSON.parse(lines[0]);
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
    "--silent", "run", alias, ...args, "--json"
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
  const source = await realpath(packageRoot);
  assert(isCanonicalPathInside(
    await realpath(join(input.consumerRoot, "node_modules")), source
  ),
    "Installed Foundation escaped the clean consumer node_modules tree.");
  assert(manifest.devDependencies?.[docsPackageName] === input.docsVersion,
    "Clean consumer must pin the exact packed Docs Protocol version.");
  const docsRoot = join(input.consumerRoot, "node_modules", "@agent-teams", "docs-protocol");
  const docsEntry = await lstat(docsRoot);
  assert(docsEntry.isDirectory() && !docsEntry.isSymbolicLink(),
    "Document E2E resolved a Docs Protocol workspace/link fallback instead of a registry package.");
  assert(isCanonicalPathInside(
    await realpath(join(input.consumerRoot, "node_modules")), await realpath(docsRoot)
  ),
    "Installed Docs Protocol escaped the clean consumer node_modules tree.");
  assert(isSameCanonicalPath(await realpath(input.installedDocsRoot), await realpath(docsRoot)),
    "Document E2E received a different installed Docs Protocol package root.");
  const foundationManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert(typeof foundationManifest.exports?.["./document-authoring/qualification"] === "object",
    "Packed Foundation does not declare its closed document-authoring qualification export.");
  const { stdout: resolutionOutput } = await runCommand(process.execPath, [
    "--input-type=module", "--eval",
    `const qualification=${JSON.stringify(`${packageName}/document-authoring/qualification`)};const manifest=${JSON.stringify(`${packageName}/package.json`)};const api=await import(qualification);if(typeof api.runDocumentAuthoringCrashQualification!=="function")process.exit(42);process.stdout.write(JSON.stringify({manifest:import.meta.resolve(manifest),qualification:import.meta.resolve(qualification)}));`,
  ], docsRoot, { timeoutMs });
  const resolved = JSON.parse(resolutionOutput);
  assert(isSameCanonicalPath(
    await realpath(fileURLToPath(resolved.manifest)), await realpath(join(packageRoot, "package.json"))
  ),
    "Docs Protocol resolves a different physical Foundation package.");
  assert(isCanonicalPathInside(
    await realpath(packageRoot), await realpath(fileURLToPath(resolved.qualification))
  ),
    "Docs Protocol qualification resolved outside the declared physical Foundation package.");
  await runCommand(process.execPath, [
    "--input-type=module", "--eval",
    `const api=await import(${JSON.stringify(`${packageName}/document-authoring`)});if(typeof api.planDocumentationDocument!=="function"||typeof api.applyDocumentationPlan!=="function")process.exit(41);`
  ], input.consumerRoot, { timeoutMs });
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

export async function writeDocsProtocolProfileFixture(consumerRoot) {
  await writeFile(join(consumerRoot, docsProfilePath), [
    "schemaVersion: 3", "protocol: {id: agent-teams.docs-protocol, version: 1}",
    "foundationProfile:", `  path: ${foundationProfilePath}`, "  schemaVersion: 3",
    "  metadataSidecarPolicy: foundation-profile-v3-strict-merge",
    "agentWorkflow: {adoption: portable-v1, skillPath: .agents/skills/docs-authoring/SKILL.md}",
    "semanticValidatorIds: []", ""
  ].join("\n"), "utf8");
}

export async function verifyRegistryDocumentAuthoring(input) {
  await assertInstalledBoundary(input);
  await writePackedConsumerDocumentAuthoringFixture(input.consumerRoot);

  await assertConsumerAliases(input.consumerRoot);
  await assertPreview(input.consumerRoot);
  await assertIdleCommands(input.consumerRoot);
  if (process.platform !== "win32") {
    await assertApplyAndReplay(input.consumerRoot);
  }
  await verifyInstalledDocsProtocol(input);
}

async function prepareDocsProtocolFixture(input) {
  const manifestPath = join(input.consumerRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.devDependencies = {
    ...manifest.devDependencies,
    [packageName]: input.version,
    [docsPackageName]: input.docsVersion
  };
  manifest.scripts = Object.fromEntries(
    ["info", "find", "new", "doctor", "recover", "check"].map((command) => [
      `docs:${command}`,
      `agent-teams-docs ${command} --consumer . --profile ${docsProfilePath}`
    ])
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(input.consumerRoot, foundationProfilePath), [
    "schemaVersion: 3", "projectId: pack-consumer", "catalog:", "  metadataSchemaPath: docs/metadata.schema.json", "  ownerCatalog: {path: docs/owners.yaml, contract: foundation.owner-map/v1}", "  collections:", "    - {kind: markdown-tree, root: docs/catalog}", "  excludedPrefixes: [docs/template.md]", "authoring:", "  mode: create-only", "  artifactTypes:", "    - type: adr", "      initialStatus: proposed", "      identity: {kind: explicit, format: adr-four-digits}", "      placement: {kind: collection, directory: docs/catalog, filename: numeric-id-slug}", "      template: {kind: fenced-markdown-body, path: docs/template.md}", "      heading: {kind: id-colon-title}", "      reachability: {kind: manual-fixed-index, indexPath: docs/catalog/README.md}", "      allowedOwnerIds: [architecture]", ""
  ].join("\n"), "utf8");
  await writeDocsProtocolProfileFixture(input.consumerRoot);
  const metadataSchemaPath = join(input.consumerRoot, "docs", "metadata.schema.json");
  const metadataSchema = JSON.parse(await readFile(metadataSchemaPath, "utf8"));
  metadataSchema.properties = {
    ...metadataSchema.properties,
    related: { type: "array", uniqueItems: true, items: { type: "string" } },
    blocked_by: { type: "array", uniqueItems: true, items: { type: "string" } },
    code_anchors: { type: "array", uniqueItems: true, items: { type: "object" } }
  };
  await writeFile(metadataSchemaPath, `${JSON.stringify(metadataSchema, null, 2)}\n`, "utf8");
  await mkdir(join(input.consumerRoot, ".agents", "skills", "docs-authoring"), { recursive: true });
  const installedDocsSkill = await readInstalledPortableDocsSkill(input.installedDocsRoot);
  await writeFile(
    join(input.consumerRoot, ".agents", "skills", "docs-authoring", "SKILL.md"),
    installedDocsSkill
  );
  await writeFile(join(input.consumerRoot, "AGENTS.md"),
    "Use [.agents/skills/docs-authoring/SKILL.md](.agents/skills/docs-authoring/SKILL.md) for documentation.\n", "utf8");
  await writeFile(join(input.consumerRoot, ".agent-teams-document-authoring-qualification-fixture.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "agent-teams-document-authoring-qualification-fixture",
    consumerRoot: await realpath(input.consumerRoot)
  })}\n`, "utf8");
  await writeFile(join(input.consumerRoot, "docs", "catalog", "README.md"),
    "---\nid: docs.catalog.index\ntype: index\nstatus: active\nowner: architecture\nsummary: Packed registry catalog index.\n---\n\n# Catalog\n", "utf8");
}

function docsNewArguments(input, mode) {
  return ["new", "--type", "adr", "--id", input.id, "--title", input.title,
    "--owner", "architecture", "--summary", "Registry-installed unified Docs Protocol qualification.",
    "--slug", input.slug, mode, "--consumer", ".", "--profile", "architecture/foundation/docs-protocol.yaml"];
}

async function applyReportedReachability(consumerRoot, result) {
  assert(result.reachability?.state === "manual-required" &&
    typeof result.reachability.indexPath === "string" && typeof result.reachability.markdownLink === "string",
  "Docs Protocol apply did not report its explicit manual reachability action.");
  const indexPath = join(consumerRoot, result.reachability.indexPath);
  const source = await readFile(indexPath, "utf8");
  await writeFile(indexPath, `${source.replace(/\n?$/u, "\n")}- ${result.reachability.markdownLink}\n`, "utf8");
}

async function compileDocsRecoveryPlan(consumerRoot) {
  const planPath = join(consumerRoot, "docs-protocol-recovery-plan.json");
  const scriptPath = join(consumerRoot, "compile-docs-protocol-recovery-plan.mjs");
  await writeFile(scriptPath, [
    `import { planDocumentationDocumentV2 } from ${JSON.stringify(`${packageName}/document-authoring`)};`,
    'import { writeFile } from "node:fs/promises";',
    "const [consumerRoot, planPath] = process.argv.slice(2);",
    "const plan = await planDocumentationDocumentV2({ consumerRoot,",
    '  profilePath: "architecture/foundation/document-authoring.yaml",',
    '  parentPolicy: "create-missing-real-directories",',
    '  intent: { schemaVersion: 1, type: "adr", id: "ADR-0051", title: "Docs Protocol Recovery",',
    '    owner: "architecture", summary: "Registry-installed unified Docs Protocol qualification.",',
    '    slug: "docs-protocol-recovery", additionalMetadata: { blocked_by: [], code_anchors: [] } }',
    "});",
    'await writeFile(planPath, `${JSON.stringify(plan)}\\n`);',
    ""
  ].join("\n"), "utf8");
  await runCommand(process.execPath, [scriptPath, consumerRoot, planPath], consumerRoot, { timeoutMs });
  return { plan: JSON.parse(await readFile(planPath, "utf8")), planPath };
}

async function assertSkewRefused(consumerRoot, expectedVersion, expectedBuildIdentity) {
  const doctor = await docsJsonCommand(consumerRoot, ["doctor", "--consumer", ".", "--profile", "architecture/foundation/docs-protocol.yaml"], 1);
  assert(doctor.outcome === "recovery-required" && doctor.result?.transaction?.state === "manual-recovery-required",
    "Docs Protocol doctor did not refuse a wrong Foundation version/build recovery route.");
  const recover = await docsJsonCommand(consumerRoot, ["recover", "--consumer", ".", "--profile", "architecture/foundation/docs-protocol.yaml"], 1);
  assert(recover.outcome === "recovery-required" && recover.result?.transactionState === "manual-required" &&
    recover.result?.transaction?.recovery?.args?.exactFoundationVersion === expectedVersion &&
    recover.result?.transaction?.recovery?.args?.exactFoundationBuildIdentity === expectedBuildIdentity,
  "Docs Protocol recover did not preserve the exact required Foundation identity under skew.");
}

function assertDocsCrashJournal(journal, plan) {
  assert(journal.schemaVersion === 4 && journal.state === "PUBLISHING" &&
    journal.payloadKind === "document-authoring-journal/v3" && journal.journal?.plan?.planDigest === plan.planDigest,
  "Docs Protocol crash did not leave the genuine v4/v3 PUBLISHING transaction.");
}

async function exerciseInstalledIdentitySkew(input, plan) {
  const foundationRoot = await installedPackageRoot(input.consumerRoot);
  const manifestPath = join(foundationRoot, "package.json");
  const manifestBytes = await readFile(manifestPath);
  const identityPath = join(foundationRoot, "dist", "index.js");
  const identityBytes = await readFile(identityPath);
  try {
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    manifest.version = "9.9.9-skew";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await assertSkewRefused(input.consumerRoot, plan.compiler.version, plan.compiler.buildIdentity);
    await writeFile(manifestPath, manifestBytes);
    await writeFile(identityPath, Buffer.concat([identityBytes, Buffer.from("\n// registry qualification build skew\n")]));
    await assertSkewRefused(input.consumerRoot, plan.compiler.version, plan.compiler.buildIdentity);
  } finally {
    await writeFile(manifestPath, manifestBytes);
    await writeFile(identityPath, identityBytes);
  }
}

async function verifyDocsCrashAndSkew(input) {
  const { plan, planPath } = await compileDocsRecoveryPlan(input.consumerRoot);
  await crashAtPublishing(input.consumerRoot, planPath);
  const journalPath = join(input.consumerRoot, ".agent-teams-local", "scaffolding-transaction.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  assertDocsCrashJournal(journal, plan);
  await exerciseInstalledIdentitySkew(input, plan);
  const doctor = await docsJsonCommand(input.consumerRoot, ["doctor", "--consumer", ".", "--profile", "architecture/foundation/docs-protocol.yaml"], 1);
  assert(doctor.outcome === "recovery-required" && doctor.result?.transaction?.state === "recoverable",
    "Docs Protocol doctor did not restore exact recovery after skew fixtures were removed.");
  const recovered = await docsJsonCommand(input.consumerRoot, ["recover", "--consumer", ".", "--profile", "architecture/foundation/docs-protocol.yaml"]);
  assert(recovered.outcome === "success" && recovered.result?.transactionState === "recovered" &&
    recovered.result?.writeState === "committed" && typeof recovered.result?.receiptDigest === "string" &&
    recovered.result?.receipt?.outcome === "applied" && recovered.result?.receipt?.commit?.publication === "published",
  "Installed Docs Protocol did not return truthful committed recovery receipt evidence.");
}

function assertDocsInfoAndFind(info, found) {
  assert(info.outcome === "success" && info.result?.projectId === "pack-consumer", "Installed Docs Protocol info failed.");
  assert(found.outcome === "success" && found.result?.documents?.some(({ id }) => id === "guide.packaged"), "Installed Docs Protocol find failed.");
}

function assertDocsPreviewAndApply(preview, applied) {
  assert(preview.outcome === "success" && preview.result?.writeState === "preview", "Installed Docs Protocol preview failed.");
  assert(applied.outcome === "success" && applied.result?.writeState === "applied" &&
    typeof applied.result?.receiptDigest === "string" && applied.result?.receipt?.commit?.publication === "published",
  "Installed Docs Protocol apply did not return truthful receipt evidence.");
}

function assertDocsHealth(check, idleDoctor, idleRecover) {
  assert(check.outcome === "success" && check.result?.valid === true, "Installed Docs Protocol check failed.");
  assert(idleDoctor.command === "docs.doctor", "Installed Docs Protocol doctor did not execute.");
  assert(idleRecover.outcome === "success" && idleRecover.result?.transactionState === "no-pending-transaction", "Installed Docs Protocol idle recover failed.");
}

async function verifyInstalledDocsProtocol(input) {
  await prepareDocsProtocolFixture(input);
  const info = await docsJsonCommand(input.consumerRoot, ["info", "--consumer", ".", "--profile", docsProfilePath]);
  assert(info.outcome === "success" && info.result?.agentWorkflow?.adoption === "portable-v1" &&
    info.result?.foundationProfile?.schemaVersion === 3 &&
    info.result?.foundationProfile?.metadataSidecarPolicy === "foundation-profile-v3-strict-merge",
  "Generated registry Docs Profile did not parse under the installed portable profile policy.");
  const found = await docsJsonCommand(input.consumerRoot, ["find", "Hermetic", "--consumer", ".", "--profile", "architecture/foundation/docs-protocol.yaml"]);
  assertDocsInfoAndFind(info, found);
  const preview = await docsJsonCommand(input.consumerRoot, docsNewArguments({ id: "ADR-0050", title: "Unified Registry Boundary", slug: "unified-registry-boundary" }, "--dry-run"));
  await assertAbsent(join(input.consumerRoot, preview.result.documentPath), "Installed Docs Protocol preview mutated the consumer.");
  const applyArguments = docsNewArguments({ id: "ADR-0050", title: "Unified Registry Boundary", slug: "unified-registry-boundary" }, "--apply");
  if (process.platform === "win32") {
    await verifyWindowsDocsRecoveryQualification({ applyArguments,
      consumerRoot: input.consumerRoot, expectedDocumentPath: preview.result.documentPath,
      runDocs: (args, exitCode) => docsJsonCommand(input.consumerRoot, args, exitCode) });
    return;
  }
  const applied = await docsJsonCommand(input.consumerRoot, applyArguments);
  assertDocsPreviewAndApply(preview, applied);
  await applyReportedReachability(input.consumerRoot, applied.result);
  const check = await docsJsonCommand(input.consumerRoot, ["check", "--consumer", ".", "--profile", "architecture/foundation/docs-protocol.yaml"]);
  const idleDoctor = await docsJsonCommand(input.consumerRoot, ["doctor", "--consumer", ".", "--profile", "architecture/foundation/docs-protocol.yaml"]);
  const idleRecover = await docsJsonCommand(input.consumerRoot, ["recover", "--consumer", ".", "--profile", "architecture/foundation/docs-protocol.yaml"]);
  assertDocsHealth(check, idleDoctor, idleRecover);
  await verifyDocsCrashAndSkew(input);
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
    found.result?.matches === 1 && found.result?.documents?.length === 1 &&
    found.result.documents[0]?.id === "guide.packaged",
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
  return realpath(join(
    consumerRoot, "node_modules", "@agent-teams", "engineering-foundation"
  ));
}

async function writeCrashWorker(consumerRoot) {
  const workerPath = join(consumerRoot, "packed-document-crash-worker.mjs");
  await writeFile(workerPath, [
    'import { readFile } from "node:fs/promises";',
    `import { runDocumentAuthoringCrashQualification } from ${JSON.stringify(`${packageName}/document-authoring/qualification`)};`,
    "const [consumerRoot, planPath] = process.argv.slice(2);",
    'const plan = JSON.parse(await readFile(planPath, "utf8"));',
    'await runDocumentAuthoringCrashQualification({ consumerRoot, plan, crashPoint: "after-publishing-journal-durable" });',
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
      if (stdout.includes('{"schemaVersion":1,"event":"document-authoring-qualification-crash-point","crashPoint":"after-publishing-journal-durable"}\n')) {
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
