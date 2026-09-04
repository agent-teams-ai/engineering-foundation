import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

import { fetchBoundedCentralAuthorityResponse } from "./bounded-central-authority-response.mjs";
import { runCommand, runNpmCommand } from "./pack-test-support.mjs";
import {
  assertPortableCoreClosure,
  assertSafeTarballInventory,
  assertTarballEntryTypes,
  assertCanaryReceiptDigest,
  assertRegistryObservations,
  finalizeCanaryReceipt,
  hostilePolicyMatrix,
  observeCentralCohortAuthority as observeCentralCohortAuthorityPolicy,
  parseCanaryInputs,
  publicationClosureDecision,
} from "./public-managed-registry-canary-policy.mjs";
import { verifiedProvenanceFromNpmAudit } from "./release-publish-ordered-runtime.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const receiptSchemaPath = join(repositoryRoot, "architecture", "foundation", "schemas", "public-managed-registry-canary-receipt-v1.schema.json");
const commandTimeout = 240_000;
const adapterSegments = ["node_modules", "@agent-teams", "docs-protocol-agent-teams"];
const FORBIDDEN_MCP = "@agent-teams/docs-protocol-mcp";

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fetchJson(url, fetcher = globalThis.fetch) {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Public npm observation failed with HTTP ${response.status} for ${url}.`);
  }
  return await response.json();
}

export async function observeCentralCohortAuthority(
  input,
  { fetcher = globalThis.fetch, ...options } = {},
) {
  return await observeCentralCohortAuthorityPolicy(input, {
    ...options,
    fetcher: (request, init) => fetchBoundedCentralAuthorityResponse(request, init, fetcher),
  });
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
    devDependencies: Object.fromEntries(authority.roots.map(({ name: packageName, version }) => [packageName, version])),
  }, null, 2)}\n`, "utf8");
}

async function assertInstalledRootManifests(root, authority) {
  for (const coordinate of authority.roots) {
    const manifest = JSON.parse(await readFile(join(root, "node_modules", ...coordinate.name.split("/"), "package.json"), "utf8"));
    if (manifest.name !== coordinate.name || manifest.version !== coordinate.version) {
      throw new Error(`Disposable install resolved unexpected identity for ${coordinate.name}.`);
    }
  }
}

function assertNoMcpClosure(lock, manager) {
  if (JSON.stringify(lock).includes(FORBIDDEN_MCP)) {
    throw new Error(`${manager} resolved forbidden Docs Protocol MCP closure.`);
  }
}

export function assertNpmLockCoordinates(lockfileBytes, authority) {
  const lock = JSON.parse(lockfileBytes.toString("utf8"));
  assertNoMcpClosure(lock, "npm");
  for (const coordinate of authority.coordinates) {
    const suffix = `node_modules/${coordinate.name}`;
    const matches = Object.entries(lock.packages ?? {}).filter(([path]) =>
      path === suffix || path.endsWith(`/${suffix}`));
    if (matches.length === 0 || matches.some(([, entry]) =>
      entry.version !== coordinate.version || entry.integrity !== coordinate.integrity)) {
      throw new Error(`npm lock evidence differs for ${coordinate.name}.`);
    }
  }
}

export function assertPnpmLockCoordinates(lockfileBytes, authority) {
  const lock = parseYaml(lockfileBytes.toString("utf8"));
  assertNoMcpClosure(lock, "pnpm");
  for (const coordinate of authority.coordinates) {
    const locator = `${coordinate.name}@${coordinate.version}`;
    const matches = Object.entries(lock.packages ?? {}).filter(([key]) =>
      key === locator || key.startsWith(`${locator}(`));
    if (matches.length === 0 || matches.some(([, entry]) =>
      entry?.resolution?.integrity !== coordinate.integrity)) {
      throw new Error(`pnpm lock evidence differs for ${coordinate.name}.`);
    }
  }
}

async function installConsumer(root, authority, manager) {
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
  const lockfile = await readFile(join(root, manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml"));
  const lockfileBytes = Buffer.from(lockfile);
  const lockfileDigest = sha256(lockfileBytes);
  if (manager === "npm") {
    assertNpmLockCoordinates(lockfileBytes, authority);
  } else {
    assertPnpmLockCoordinates(lockfileBytes, authority);
  }
  await assertInstalledRootManifests(root, authority);
  for (const coordinate of authority.roots) {
    await runCommand(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(coordinate.name)});`], root, {
      timeoutMs: commandTimeout,
    });
  }
  return Object.freeze({
    lockfileBytes,
    receipt: Object.freeze({
      fivePackageLockValidated: true,
      lockfileDigest,
      manager,
      mcpAbsent: true,
      rootCount: authority.roots.length,
    }),
  });
}

async function npmSignatureEvidence(root, authority) {
  const result = await runNpmCommand([
    "audit", "signatures", "--json", "--include-attestations", "--registry", authority.registry,
    "--userconfig", join(root, ".npmrc"),
  ], root, { timeoutMs: commandTimeout });
  return JSON.parse(result.stdout);
}

function assertProvenanceAncestor(provenanceCommit, expectedCommit, packageName) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", provenanceCommit, expectedCommit], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Provenance commit is not an ancestor of expected commit for ${packageName}.`);
  }
  return true;
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
  return Object.freeze({
    ...assertPortableCoreClosure({ contents: docsInventory.contents, dependencies: manifest.dependencies, entries: docsInventory.entries }),
    lockfileDigest: sha256(await readFile(join(portableRoot, "package-lock.json"))),
  });
}

function qualificationProfile(cohort, repository) {
  return Object.freeze({
    schemaVersion: 3,
    repository,
    integrationRoot: ".",
    packageManager: "pnpm",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    skillPath: ".agents/skills/docs-authoring/SKILL.md",
    callerWorkflowPath: ".github/workflows/docs-protocol.yml",
    managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
    qualification: {
      contractPath: "architecture/foundation/docs-protocol-qualification.json",
      gateCommand: "pnpm docs:protocol:check",
    },
    cohort,
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).toSorted(([left], [right]) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function assertQualificationReceiptDigest(receipt) {
  const { receiptDigest, ...body } = receipt;
  if (receiptDigest !== sha256(Buffer.from(canonicalJson(body), "utf8"))) {
    throw new Error("Qualification v3 receipt digest is not independently canonical.");
  }
}

export function assertCanonicalManagedState(serialization) {
  if (typeof serialization !== "string" || !serialization.endsWith("\n")) {
    throw new Error("Managed-state v2 serialization is not newline terminated.");
  }
  const state = JSON.parse(serialization);
  if (serialization !== `${canonicalJson(state)}\n`) {
    throw new Error("Managed-state v2 serialization is not canonical JSON.");
  }
  const { stateDigest, ...body } = state;
  const expected = sha256(Buffer.from(canonicalJson({
    domain: "agent-teams.docs-protocol.managed-state/v2",
    body,
  }), "utf8"));
  if (stateDigest !== expected) {
    throw new Error("Managed-state v2 stateDigest is invalid.");
  }
  return state;
}

async function validateManagedQualification(root, qualificationReceipt, managedStateSerialization, profile) {
  assertQualificationReceiptDigest(qualificationReceipt);
  const managedState = assertCanonicalManagedState(managedStateSerialization);
  const schemaRoot = join(root, ...adapterSegments, "schemas");
  const qualificationSchema = JSON.parse(await readFile(join(schemaRoot, "docs-protocol-qualification-receipt", "v3.schema.json"), "utf8"));
  const cohortSchema = JSON.parse(await readFile(join(schemaRoot, "qualified-docs-cohort", "v2.schema.json"), "utf8"));
  const profileSchema = JSON.parse(await readFile(join(schemaRoot, "docs-consumer-integration-profile", "v3.schema.json"), "utf8"));
  const managedSchema = JSON.parse(await readFile(join(schemaRoot, "docs-consumer-managed-state", "v2.schema.json"), "utf8"));
  const docsProtocolSchema = JSON.parse(await readFile(join(schemaRoot, "docs-protocol-profile", "v1.schema.json"), "utf8"));
  if (profileSchema.$id !== "https://agent-teams.ai/schemas/docs-consumer-integration-profile/v3" ||
      managedSchema.$id !== "https://agent-teams.ai/schemas/docs-consumer-managed-state/v2" ||
      docsProtocolSchema.$id !== "https://agent-teams.ai/schemas/docs-protocol-profile/v1") {
    throw new Error("Installed schema tuple identity is not exactly 3/2/1.");
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(cohortSchema);
  for (const [label, schema, value] of [
    ["consumer integration profile v3", profileSchema, profile],
    ["qualification receipt v3", qualificationSchema, qualificationReceipt],
    ["managed state v2", managedSchema, managedState],
  ]) {
    const validate = ajv.compile(schema);
    if (!validate(value)) {
      throw new Error(`Installed ${label} schema validation failed: ${JSON.stringify(validate.errors)}`);
    }
  }
  ajv.compile(docsProtocolSchema);
  return managedState;
}

async function managedQualification(root, authority, repository, observedPackages, lockfileEvidence) {
  if (sha256(lockfileEvidence.lockfileBytes) !== lockfileEvidence.receipt.lockfileDigest) {
    throw new Error("Captured pnpm lockfile bytes differ from install receipt digest.");
  }
  const authorityProfile = qualificationProfile(authority.cohort, repository);
  const capturedLockfile = lockfileEvidence.lockfileBytes.toString("base64");
  const program = [
    "import { createHash } from 'node:crypto';",
    `const authorityProfile = ${JSON.stringify(authorityProfile)};`,
    `const capturedLockfileBytes = Buffer.from(${JSON.stringify(capturedLockfile)}, 'base64');`,
    `const expectedLockfileDigest = ${JSON.stringify(lockfileEvidence.receipt.lockfileDigest)};`,
    "if (`sha256:${createHash('sha256').update(capturedLockfileBytes).digest('hex')}` !== expectedLockfileDigest) throw new Error('Embedded lockfile capture digest mismatch.');",
    "const exactLockfileBytes = () => Buffer.from(capturedLockfileBytes);",
    "const { canonicalDocsScriptsDigest, canonicalManagedRoute, canonicalManagedState, describeCanonicalConsumerAssets } = await import('@agent-teams/docs-protocol-agent-teams');",
    "const { observeDocsProtocolQualificationV3Lockfile, runDocsProtocolQualificationV3 } = await import('@agent-teams/docs-protocol-agent-teams/qualification');",
    "const observed = observeDocsProtocolQualificationV3Lockfile({ profile: authorityProfile, lockfileBytes: exactLockfileBytes() });",
    "if (observed.runtimeClosureDigest !== authorityProfile.cohort.runtime.runtimeClosureDigest) throw new Error('Observed runtime closure differs from Cohort authority.');",
    "const trustedCohort = { ...authorityProfile.cohort, runtime: { ...authorityProfile.cohort.runtime, runtimeClosureDigest: observed.runtimeClosureDigest } };",
    "const profile = { ...authorityProfile, cohort: trustedCohort };",
    `const evidence = { packages: ${JSON.stringify(observedPackages)}, schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 }, runtimeClosureDigest: observed.runtimeClosureDigest };`,
    "const receipt = runDocsProtocolQualificationV3({ profile, evidence, lockfileBytes: exactLockfileBytes() });",
    "const canonical = describeCanonicalConsumerAssets(profile.cohort);",
    "const routeDigest = `sha256:${createHash('sha256').update(canonicalManagedRoute(profile.skillPath)).digest('hex')}`;",
    "const assets = { ...canonical, agentsRouteDigest: routeDigest, docsScriptsDigest: canonicalDocsScriptsDigest(profile.profilePath) };",
    "const managedState = canonicalManagedState(profile, assets);",
    "process.stdout.write(JSON.stringify({ managedState, observed, receipt }));",
  ].join("\n");
  const result = await runCommand(process.execPath, ["--input-type=module", "--eval", program], root, { timeoutMs: commandTimeout });
  const output = JSON.parse(result.stdout);
  const managedState = await validateManagedQualification(
    root,
    output.receipt,
    output.managedState,
    qualificationProfile(authority.cohort, repository),
  );
  if (output.observed.runtimeClosureDigest !== output.receipt.runtime.runtimeClosureDigest ||
      managedState.schemaVersion !== 2) {
    throw new Error("Managed qualification evidence is internally inconsistent.");
  }
  return Object.freeze({
    actualRuntimeClosureDigest: output.observed.runtimeClosureDigest,
    managedState: Object.freeze({
      schemaVersion: 2,
      schemaValidated: true,
      serialization: output.managedState,
      stateDigest: managedState.stateDigest,
    }),
    qualificationReceipt: Object.freeze(output.receipt),
    schemaEvidence: Object.freeze({
      consumerIntegration: 3,
      docsProtocol: 1,
      managedState: 2,
      validated: true,
    }),
  });
}

async function validateReceipt(receipt) {
  const schema = JSON.parse(await readFile(receiptSchemaPath, "utf8"));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(receipt)) {
    throw new Error(`Canary receipt schema validation failed: ${JSON.stringify(validate.errors)}`);
  }
}

export async function runPublicManagedRegistryCanary({ authority, outputPath, repository, run }) {
  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "public-managed-registry-canary-")));
  try {
    const observations = await observeCoordinates(authority);
    const closure = publicationClosureDecision(authority, observations);
    if (closure.status !== "ready") {
      throw new Error(`Public package graph is incomplete: ${closure.missing.join(", ")}.`);
    }
    assertRegistryObservations(authority, observations);

    const npmRoot = join(temporaryRoot, "npm-three-root");
    const pnpmRoot = join(temporaryRoot, "pnpm-three-root");
    const npmInstall = await installConsumer(npmRoot, authority, "npm");
    const pnpmInstall = await installConsumer(pnpmRoot, authority, "pnpm");
    const signatureEvidence = await npmSignatureEvidence(npmRoot, authority);
    const inventories = new Map();
    const packages = [];
    for (const coordinate of authority.coordinates) {
      const inventory = await packInventory(npmRoot, coordinate, authority);
      inventories.set(coordinate.name, inventory);
      const provenance = verifiedProvenanceFromNpmAudit(signatureEvidence, coordinate, authority.source);
      packages.push(Object.freeze({
        integrity: coordinate.integrity,
        latest: observations[coordinate.name].latest,
        name: coordinate.name,
        provenanceAncestorOfExpectedCommit: assertProvenanceAncestor(provenance.commit, authority.expectedCommit, coordinate.name),
        provenanceCommit: provenance.commit,
        tarballEntries: inventory.entries.length,
        version: coordinate.version,
      }));
    }
    const portable = await portableNegative(npmRoot, authority, inventories.get("@agent-teams/docs-protocol"));
    const observedPackages = Object.fromEntries(authority.coordinates.map(({ key, name }) => [key, {
      integrity: observations[name].integrity,
      version: observations[name].version,
    }]));
    const qualification = await managedQualification(
      pnpmRoot,
      authority,
      repository,
      observedPackages,
      pnpmInstall,
    );
    const hostile = [
      ...hostilePolicyMatrix(authority),
      { id: "tarball-inventory", mode: "installed-execution", outcome: "passed" },
      { id: "portable-managed-denylist", mode: "installed-execution", outcome: "passed" },
      { id: "qualification-v3", mode: "installed-execution", outcome: "passed" },
      { id: "managed-state-v2-schema", mode: "installed-execution", outcome: "passed" },
    ];
    const receipt = finalizeCanaryReceipt({
      schemaVersion: 1,
      run,
      authority: {
        central: authority.central,
        cohort: authority.cohort,
        expectedCommit: authority.expectedCommit,
        registry: authority.registry,
      },
      packages,
      installs: [npmInstall.receipt, pnpmInstall.receipt],
      portableNegative: portable,
      managedQualification: qualification,
      hostile,
    });
    if (new Set(packages.map(({ name }) => name)).size !== packages.length ||
        new Set(hostile.map(({ id }) => id)).size !== hostile.length) {
      throw new Error("Canary receipt evidence contains duplicate identities.");
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
  const inputs = parseCanaryInputs({
    authorityRevision: process.env.PUBLIC_CANARY_AUTHORITY_REVISION,
    cohortId: process.env.PUBLIC_CANARY_COHORT_ID,
    expectedCommit: process.env.PUBLIC_CANARY_EXPECTED_COMMIT,
  });
  const outputPath = resolve(process.env.PUBLIC_CANARY_RECEIPT_PATH ?? "public-managed-registry-canary-receipt.json");
  const runId = Number(process.env.GITHUB_RUN_ID);
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (!Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(runAttempt) || runAttempt < 1) {
    throw new Error("Public canary requires exact GitHub run identity.");
  }
  const repositoryId = process.env.GITHUB_REPOSITORY_ID;
  const repositoryName = process.env.GITHUB_REPOSITORY;
  if (!/^[1-9][0-9]*$/u.test(repositoryId ?? "") ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repositoryName ?? "")) {
    throw new Error("Public canary requires actual GitHub repository identity.");
  }
  const repository = Object.freeze({ provider: "github", id: repositoryId, nameWithOwner: repositoryName });
  const authority = await observeCentralCohortAuthority({ inputs, repository });
  const receipt = await runPublicManagedRegistryCanary({
    authority,
    outputPath,
    repository,
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
