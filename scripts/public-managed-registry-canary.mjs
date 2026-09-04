import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";

import { runCommand, runNpmCommand } from "./pack-test-support.mjs";
import {
  assertPortableCoreClosure,
  assertSafeTarballInventory,
  assertTarballEntryTypes,
  assertCanaryReceiptDigest,
  finalizeCanaryReceipt,
  hostilePolicyMatrix,
  parseCanaryAuthority,
  publicationClosureDecision,
} from "./public-managed-registry-canary-policy.mjs";
import { verifiedProvenanceFromNpmAudit } from "./release-publish-ordered-runtime.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const receiptSchemaPath = join(repositoryRoot, "architecture", "foundation", "schemas", "public-managed-registry-canary-receipt-v1.schema.json");
const managedFixtureRoot = join(repositoryRoot, "packages", "docs-protocol-agent-teams", "tests", "fixtures", "qualification");
const commandTimeout = 240_000;

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Public npm observation failed with HTTP ${response.status} for ${url}.`);
  }
  return await response.json();
}

async function observeCoordinates(authority) {
  return Object.fromEntries(await Promise.all(authority.coordinates.map(async (coordinate) => {
    const packument = await fetchJson(new URL(encodeURIComponent(coordinate.name), authority.registry));
    const exact = packument?.versions?.[coordinate.version];
    return [coordinate.name, {
      integrity: exact?.dist?.integrity,
      latest: packument?.["dist-tags"]?.latest,
      version: exact?.version,
    }];
  })));
}

async function writeConsumer(root, authority, name) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, ".npmrc"), [
    `registry=${authority.registry}`,
    `@agent-teams:registry=${authority.registry}`,
    "audit=false",
    "fund=false",
    "provenance=false",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name,
    private: true,
    type: "module",
    devDependencies: Object.fromEntries(authority.coordinates.map(({ name: packageName, version }) => [packageName, version])),
  }, null, 2)}\n`, "utf8");
}

async function assertInstalledCoordinates(root, authority) {
  for (const coordinate of authority.coordinates) {
    const manifest = JSON.parse(await readFile(join(root, "node_modules", ...coordinate.name.split("/"), "package.json"), "utf8"));
    if (manifest.name !== coordinate.name || manifest.version !== coordinate.version) {
      throw new Error(`Disposable install resolved unexpected identity for ${coordinate.name}.`);
    }
    await runCommand(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(coordinate.name)});`], root, {
      timeoutMs: commandTimeout,
    });
  }
}

async function installAll(root, authority, manager) {
  await writeConsumer(root, authority, `public-managed-canary-${manager}`);
  if (manager === "npm") {
    await runNpmCommand([
      "install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=true",
      "--registry", authority.registry, "--userconfig", join(root, ".npmrc"),
    ], root, { timeoutMs: commandTimeout });
  } else {
    await runCommand("pnpm", [
      "install", "--ignore-scripts", "--frozen-lockfile=false", "--registry", authority.registry,
      `--config.userconfig=${join(root, ".npmrc")}`, "--store-dir", join(root, ".pnpm-store"),
    ], root, { timeoutMs: commandTimeout });
  }
  await assertInstalledCoordinates(root, authority);
  const lockfile = await readFile(join(root, manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml"));
  return Object.freeze({ lockfileDigest: sha256(lockfile), manager, packageCount: authority.coordinates.length });
}

async function npmSignatureEvidence(root, authority) {
  const result = await runNpmCommand([
    "audit", "signatures", "--json", "--include-attestations", "--registry", authority.registry,
    "--userconfig", join(root, ".npmrc"),
  ], root, { timeoutMs: commandTimeout });
  return JSON.parse(result.stdout);
}

async function packInventory(root, coordinate, authority) {
  const destination = join(root, "packs", coordinate.name.replaceAll("/", "-").replace("@", ""));
  await mkdir(destination, { recursive: true });
  const result = await runNpmCommand([
    "pack", `${coordinate.name}@${coordinate.version}`, "--json", "--ignore-scripts",
    "--pack-destination", destination, "--registry", authority.registry,
    "--userconfig", join(root, ".npmrc"),
  ], root, { timeoutMs: commandTimeout });
  const report = JSON.parse(result.stdout);
  const item = Array.isArray(report) ? report[0] : report;
  if (item?.name !== coordinate.name || item.version !== coordinate.version || item.integrity !== coordinate.integrity) {
    throw new Error(`npm pack identity differs from authority for ${coordinate.name}.`);
  }
  const archives = (await readdir(destination)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`npm pack did not create one bounded archive for ${coordinate.name}.`);
  }
  const archivePath = join(destination, archives[0]);
  const listed = await runCommand("tar", ["-tzf", archivePath], root, { timeoutMs: commandTimeout });
  const entries = listed.stdout.trim().split("\n").filter(Boolean);
  assertSafeTarballInventory(entries, coordinate.name);
  const verbose = await runCommand("tar", ["-tvzf", archivePath], root, { timeoutMs: commandTimeout });
  assertTarballEntryTypes(verbose.stdout, coordinate.name);
  const contents = coordinate.name === "@agent-teams/docs-protocol"
    ? (await runCommand("tar", ["-xOzf", archivePath], root, { timeoutMs: commandTimeout })).stdout
    : "";
  return Object.freeze({ contents, entries, report: item });
}

async function portableNegative(root, authority, docsInventory) {
  const coordinate = authority.coordinates.find(({ name }) => name === "@agent-teams/docs-protocol");
  const portableRoot = join(root, "portable-only");
  await mkdir(portableRoot, { recursive: true });
  await writeFile(join(portableRoot, ".npmrc"), await readFile(join(root, ".npmrc")));
  await writeFile(join(portableRoot, "package.json"), `${JSON.stringify({
    name: "public-portable-negative",
    private: true,
    devDependencies: { [coordinate.name]: coordinate.version },
  }, null, 2)}\n`);
  await runNpmCommand([
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=true",
    "--registry", authority.registry, "--userconfig", join(portableRoot, ".npmrc"),
  ], portableRoot, { timeoutMs: commandTimeout });
  const tree = JSON.parse((await runNpmCommand(["ls", "--all", "--json"], portableRoot, { timeoutMs: commandTimeout })).stdout);
  const pending = [tree];
  const names = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    for (const [name, child] of Object.entries(current?.dependencies ?? {})) {
      names.add(name);
      pending.push(child);
    }
  }
  if (names.has("@agent-teams/docs-protocol-agent-teams")) {
    throw new Error("Portable-only install resolved the managed adapter.");
  }
  const manifest = JSON.parse(await readFile(join(portableRoot, "node_modules", "@agent-teams", "docs-protocol", "package.json"), "utf8"));
  const policy = assertPortableCoreClosure({
    contents: docsInventory.contents,
    dependencies: manifest.dependencies,
    entries: docsInventory.entries,
  });
  return Object.freeze({
    ...policy,
    lockfileDigest: sha256(await readFile(join(portableRoot, "package-lock.json"))),
  });
}

async function snapshotTree(root) {
  const entries = [];
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), path);
      } else if (entry.isFile()) {
        entries.push([path, sha256(await readFile(join(directory, entry.name)))]);
      } else {
        entries.push([path, entry.isSymbolicLink() ? "symbolic-link" : "other"]);
      }
    }
  }
  await visit(root);
  return sha256(JSON.stringify(entries.toSorted(([left], [right]) => left.localeCompare(right))));
}

async function managedQualification(root) {
  const fixture = join(root, "managed-fixture");
  await cp(managedFixtureRoot, fixture, { recursive: true, dereference: false, errorOnExist: true, force: false });
  const before = await snapshotTree(fixture);
  const program = [
    "import { runDocsProtocolQualificationV2 } from '@agent-teams/docs-protocol-agent-teams/qualification';",
    `const receipt = await runDocsProtocolQualificationV2({ consumerRoot: ${JSON.stringify(fixture)}, localDevelopment: true });`,
    "process.stdout.write(JSON.stringify(receipt));",
  ].join("\n");
  const result = await runCommand(process.execPath, ["--input-type=module", "--eval", program], root, { timeoutMs: commandTimeout });
  const receipt = JSON.parse(result.stdout);
  const after = await snapshotTree(fixture);
  if (before !== after || receipt.evidenceClass !== "local-development" ||
      receipt.cohortAdmissible !== false || !receipt.checks?.includes("recover") ||
      !receipt.checks.includes("source-unchanged") || !Array.isArray(receipt.scenarios) ||
      receipt.scenarios.length === 0) {
    throw new Error("Managed qualification did not preserve its owned disposable source fixture.");
  }
  return Object.freeze({
    cohortAdmissible: receipt.cohortAdmissible,
    evidenceClass: receipt.evidenceClass,
    receiptDigest: receipt.receiptDigest,
    sourceUnchanged: true,
  });
}

async function validateReceipt(receipt) {
  const schema = JSON.parse(await readFile(receiptSchemaPath, "utf8"));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(receipt)) {
    throw new Error(`Canary receipt schema validation failed: ${JSON.stringify(validate.errors)}`);
  }
}

export async function runPublicManagedRegistryCanary({ authority, outputPath, run }) {
  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "public-managed-registry-canary-")));
  try {
    const observations = await observeCoordinates(authority);
    const closure = publicationClosureDecision(authority, observations);
    if (closure.status !== "ready") {
      throw new Error(`Public package graph is incomplete: ${closure.missing.join(", ")}.`);
    }
    for (const coordinate of authority.coordinates) {
      const observation = observations[coordinate.name];
      if (observation.integrity !== coordinate.integrity || observation.latest !== coordinate.version) {
        throw new Error(`Public registry identity or latest tag drifted for ${coordinate.name}@${coordinate.version}.`);
      }
    }

    const npmRoot = join(temporaryRoot, "npm-six");
    const pnpmRoot = join(temporaryRoot, "pnpm-six");
    const installs = [await installAll(npmRoot, authority, "npm"), await installAll(pnpmRoot, authority, "pnpm")];
    const signatureEvidence = await npmSignatureEvidence(npmRoot, authority);
    const inventories = new Map();
    const packages = [];
    for (const coordinate of authority.coordinates) {
      const inventory = await packInventory(npmRoot, coordinate, authority);
      inventories.set(coordinate.name, inventory);
      const provenance = verifiedProvenanceFromNpmAudit(signatureEvidence, coordinate, authority.source);
      if (provenance.commit !== authority.expectedCommit) {
        throw new Error(`Provenance commit differs for ${coordinate.name}@${coordinate.version}.`);
      }
      packages.push(Object.freeze({
        ...coordinate,
        latest: observations[coordinate.name].latest,
        provenanceCommit: provenance.commit,
        tarballEntries: inventory.entries.length,
      }));
    }
    const portable = await portableNegative(npmRoot, authority, inventories.get("@agent-teams/docs-protocol"));
    const qualification = await managedQualification(npmRoot);
    const hostile = [
      ...hostilePolicyMatrix(authority),
      { id: "tarball-inventory", mode: "installed-execution", outcome: "passed" },
      { id: "portable-managed-denylist", mode: "installed-execution", outcome: "passed" },
      { id: "managed-interruption-recovery", mode: "installed-execution", outcome: "passed" },
    ];
    const receipt = finalizeCanaryReceipt({
      schemaVersion: 1,
      run,
      authority: { expectedCommit: authority.expectedCommit, registry: authority.registry },
      packages,
      installs,
      portableNegative: portable,
      managedQualification: qualification,
      hostile,
    });
    if (new Set(hostile.map(({ id }) => id)).size !== hostile.length) {
      throw new Error("Canary hostile evidence contains duplicate identities.");
    }
    await validateReceipt(receipt);
    assertCanaryReceiptDigest(receipt);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return receipt;
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function main() {
  const authority = parseCanaryAuthority(process.env.PUBLIC_CANARY_COORDINATES, process.env.PUBLIC_CANARY_EXPECTED_COMMIT);
  const outputPath = resolve(process.env.PUBLIC_CANARY_RECEIPT_PATH ?? "public-managed-registry-canary-receipt.json");
  const runId = Number(process.env.GITHUB_RUN_ID);
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (!Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(runAttempt) || runAttempt < 1) {
    throw new Error("Public canary requires exact GitHub run identity.");
  }
  const receipt = await runPublicManagedRegistryCanary({
    authority,
    outputPath,
    run: {
      repository: process.env.GITHUB_REPOSITORY,
      runId,
      runAttempt,
      createdAt: new Date().toISOString(),
    },
  });
  process.stdout.write(`Public managed registry canary PASS: ${receipt.packages.length} exact packages, receipt ${receipt.receiptDigest}.\n`);
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  await main();
}
