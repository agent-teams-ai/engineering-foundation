import {
  sha256,
  fetchJson,
  writeConsumer,
  assertInstalledRootManifests,
  assertNpmLockCoordinates,
  assertPnpmLockCoordinates,
  packInventory,
} from "./public-managed-registry-canary-installation.ts";
export {
  assertNpmLockCoordinates,
  assertPnpmLockCoordinates,
} from "./public-managed-registry-canary-installation.ts";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";

import { fetchBoundedCentralAuthorityResponse } from "./bounded-central-authority-response.mjs";
import { runCommand, runNpmCommand } from "./pack-test-support.mjs";
import {
  assertPortableCoreClosure,
  assertCanaryReceiptDigest,
  assertRegistryObservations,
  finalizeCanaryReceipt,
  hostilePolicyMatrix,
  observeCentralCohortAuthority as observeCentralCohortAuthorityPolicy,
  parseCanaryInputs,
  publicationClosureDecision,
} from "./public-managed-registry-canary-policy.mjs";
import {
  observeSupportingMcp,
  qualifySupportingMcp,
} from "./public-managed-registry-canary-mcp.mjs";
import { observeQualificationRuntime } from "./public-managed-registry-canary-runtime-policy.mts";
import {
  assertCanonicalManagedState,
  assertCohortV3QualificationReceiptDigest,
  assertQualificationReceiptDigest,
  managedQualificationCohortV2,
  managedQualificationCohortV3,
} from "./public-managed-registry-canary-qualification.mts";
import { verifiedProvenanceFromNpmAudit } from "./release-publish-ordered-runtime.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const receiptSchemaPaths = Object.freeze({
  1: join(
    repositoryRoot,
    "architecture",
    "foundation",
    "schemas",
    "public-managed-registry-canary-receipt-v1.schema.json",
  ),
  2: join(
    repositoryRoot,
    "architecture",
    "foundation",
    "schemas",
    "public-managed-registry-canary-receipt-v2.schema.json",
  ),
});
const commandTimeout = 240_000;
const qualificationHost = Object.freeze({
  parseJson: (value) => JSON.parse(value),
  readSchema: async (path) => JSON.parse(await readFile(path, "utf8")),
  run: async (command, args, cwd, options) => await runCommand(command, [...args], cwd, options),
});

export {
  assertCanonicalManagedState,
  assertCohortV3QualificationReceiptDigest,
  assertQualificationReceiptDigest,
};

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
  return Object.fromEntries(
    await Promise.all(
      authority.coordinates.map(async (coordinate) => {
        const packument = await fetchJson(
          new URL(encodeURIComponent(coordinate.name), authority.registry),
        );
        const exact = packument?.versions?.[coordinate.version];
        return [
          coordinate.name,
          {
            integrity: exact?.dist?.integrity,
            latest: packument?.["dist-tags"]?.latest,
            version: exact?.version,
          },
        ];
      }),
    ),
  );
}

async function installConsumer(root, authority, manager, runtimeObservation) {
  if (
    authority.cohort.schemaVersion === 3 &&
    manager === "pnpm" &&
    (runtimeObservation === undefined ||
      runtimeObservation.nodeVersion !== "26.11.1" ||
      runtimeObservation.pnpmVersion !== "11.20.0" ||
      runtimeObservation.platform !== "linux" ||
      runtimeObservation.architecture !== "x64")
  ) {
    throw new Error("Pre-install runtime observation is not the exact qualified tuple.");
  }
  const boundRuntimeObservation =
    authority.cohort.schemaVersion === 3 && manager === "pnpm" ? runtimeObservation : undefined;
  await writeConsumer(root, authority, `public-managed-canary-${manager}`);
  if (manager === "npm") {
    await runNpmCommand(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=true",
        "--registry",
        authority.registry,
        "--userconfig",
        join(root, ".npmrc"),
      ],
      root,
      { timeoutMs: commandTimeout },
    );
  } else {
    await runCommand(
      "pnpm",
      [
        "install",
        "--ignore-scripts",
        "--frozen-lockfile=false",
        "--registry",
        authority.registry,
        `--config.userconfig=${join(root, ".npmrc")}`,
        "--store-dir",
        join(root, ".pnpm-store"),
      ],
      root,
      { timeoutMs: commandTimeout },
    );
  }
  const lockfile = await readFile(
    join(root, manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml"),
  );
  const lockfileBytes = Buffer.from(lockfile);
  const lockfileDigest = sha256(lockfileBytes);
  if (manager === "npm") {
    assertNpmLockCoordinates(lockfileBytes, authority);
  } else {
    assertPnpmLockCoordinates(lockfileBytes, authority);
  }
  await assertInstalledRootManifests(root, authority);
  for (const coordinate of authority.roots) {
    await runCommand(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(coordinate.name)});`],
      root,
      {
        timeoutMs: commandTimeout,
      },
    );
  }
  return Object.freeze({
    lockfileBytes,
    ...(boundRuntimeObservation === undefined
      ? {}
      : { runtimeObservation: boundRuntimeObservation }),
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
  const result = await runNpmCommand(
    [
      "audit",
      "signatures",
      "--json",
      "--include-attestations",
      "--registry",
      authority.registry,
      "--userconfig",
      join(root, ".npmrc"),
    ],
    root,
    { timeoutMs: commandTimeout },
  );
  return JSON.parse(result.stdout);
}

function assertProvenanceAncestor(provenanceCommit, expectedCommit, packageName) {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", provenanceCommit, expectedCommit],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Provenance commit is not an ancestor of expected commit for ${packageName}.`);
  }
  return true;
}

async function portableNegative(root, authority, docsInventory) {
  const coordinate = authority.coordinates.find(
    ({ name }) => name === "@agent-teams/docs-protocol",
  );
  const portableRoot = join(root, "portable-only");
  await mkdir(portableRoot, { recursive: true });
  await writeFile(join(portableRoot, ".npmrc"), await readFile(join(root, ".npmrc")));
  await writeFile(
    join(portableRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "public-portable-negative",
        private: true,
        devDependencies: { [coordinate.name]: coordinate.version },
      },
      null,
      2,
    )}\n`,
  );
  await runNpmCommand(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=true",
      "--registry",
      authority.registry,
      "--userconfig",
      join(portableRoot, ".npmrc"),
    ],
    portableRoot,
    { timeoutMs: commandTimeout },
  );
  const tree = JSON.parse(
    (await runNpmCommand(["ls", "--all", "--json"], portableRoot, { timeoutMs: commandTimeout }))
      .stdout,
  );
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
  const manifest = JSON.parse(
    await readFile(
      join(portableRoot, "node_modules", "@agent-teams", "docs-protocol", "package.json"),
      "utf8",
    ),
  );
  return Object.freeze({
    ...assertPortableCoreClosure({
      contents: docsInventory.contents,
      dependencies: manifest.dependencies,
      entries: docsInventory.entries,
    }),
    lockfileDigest: sha256(await readFile(join(portableRoot, "package-lock.json"))),
  });
}

async function validateReceipt(receipt) {
  const schemaPath = Reflect.get(receiptSchemaPaths, receipt.schemaVersion);
  if (typeof schemaPath !== "string") {
    throw new Error(`Unsupported canary receipt schemaVersion ${String(receipt.schemaVersion)}.`);
  }
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(receipt)) {
    throw new Error(`Canary receipt schema validation failed: ${JSON.stringify(validate.errors)}`);
  }
}

export async function runPublicManagedRegistryCanary({ authority, outputPath, repository, run }) {
  const temporaryRoot = await realpath(
    await mkdtemp(join(tmpdir(), "public-managed-registry-canary-")),
  );
  try {
    const [observations, supportingMcpCoordinateValue] = await Promise.all([
      observeCoordinates(authority),
      observeSupportingMcp(authority),
    ]);
    const closure = publicationClosureDecision(authority, observations);
    if (closure.status !== "ready") {
      throw new Error(`Public package graph is incomplete: ${closure.missing.join(", ")}.`);
    }
    assertRegistryObservations(authority, observations);

    const runtimeObservation =
      authority.cohort.schemaVersion === 3 ? observeQualificationRuntime() : undefined;
    const npmRoot = join(temporaryRoot, "npm-three-root");
    const pnpmRoot = join(temporaryRoot, "pnpm-three-root");
    const npmInstall = await installConsumer(npmRoot, authority, "npm", runtimeObservation);
    const pnpmInstall = await installConsumer(pnpmRoot, authority, "pnpm", runtimeObservation);
    const supportingReleasePrecondition = await qualifySupportingMcp(
      join(temporaryRoot, "npm-supporting-mcp"),
      authority,
      supportingMcpCoordinateValue,
    );
    const signatureEvidence = await npmSignatureEvidence(npmRoot, authority);
    const inventories = new Map();
    const packages = [];
    for (const coordinate of authority.coordinates) {
      const inventory = await packInventory(npmRoot, coordinate, authority);
      inventories.set(coordinate.name, inventory);
      const provenance = verifiedProvenanceFromNpmAudit(
        signatureEvidence,
        coordinate,
        authority.source,
      );
      packages.push(
        Object.freeze({
          integrity: coordinate.integrity,
          latest: observations[coordinate.name].latest,
          name: coordinate.name,
          provenanceAncestorOfExpectedCommit: assertProvenanceAncestor(
            provenance.commit,
            authority.expectedCommit,
            coordinate.name,
          ),
          provenanceCommit: provenance.commit,
          tarballEntries: inventory.entries.length,
          version: coordinate.version,
        }),
      );
    }
    const portable = await portableNegative(
      npmRoot,
      authority,
      inventories.get("@agent-teams/docs-protocol"),
    );
    const observedPackages = Object.fromEntries(
      authority.coordinates.map(({ key, name }) => [
        key,
        {
          integrity: observations[name].integrity,
          version: observations[name].version,
        },
      ]),
    );
    const qualification =
      authority.cohort.schemaVersion === 3
        ? await managedQualificationCohortV3(
            pnpmRoot,
            authority,
            repository,
            { observedPackages, lockfileEvidence: pnpmInstall },
            qualificationHost,
          )
        : await managedQualificationCohortV2(
            pnpmRoot,
            authority,
            repository,
            { observedPackages, lockfileEvidence: pnpmInstall },
            qualificationHost,
          );
    const hostile = [
      ...hostilePolicyMatrix(authority),
      { id: "tarball-inventory", mode: "installed-execution", outcome: "passed" },
      { id: "portable-managed-denylist", mode: "installed-execution", outcome: "passed" },
      { id: "qualification-v3", mode: "installed-execution", outcome: "passed" },
      {
        id:
          authority.cohort.schemaVersion === 3
            ? "managed-state-v3-schema"
            : "managed-state-v2-schema",
        mode: "installed-execution",
        outcome: "passed",
      },
    ];
    const receipt = finalizeCanaryReceipt({
      schemaVersion: authority.cohort.schemaVersion === 3 ? 2 : 1,
      run,
      authority: {
        central: authority.central,
        cohort: authority.cohort,
        expectedCommit: authority.expectedCommit,
        registry: authority.registry,
      },
      packages,
      supportingReleasePrecondition,
      installs: [
        npmInstall.receipt,
        authority.cohort.schemaVersion === 3
          ? { ...pnpmInstall.receipt, runtimeObservation }
          : pnpmInstall.receipt,
      ],
      portableNegative: portable,
      managedQualification: qualification,
      hostile,
    });
    const releasePackageNames = [
      ...packages.map(({ name }) => name),
      supportingReleasePrecondition.package.name,
    ];
    if (
      new Set(releasePackageNames).size !== releasePackageNames.length ||
      new Set(hostile.map(({ id }) => id)).size !== hostile.length
    ) {
      throw new Error("Canary receipt evidence contains duplicate identities.");
    }
    await validateReceipt(receipt);
    assertCanaryReceiptDigest(receipt);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
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
  const outputPath = resolve(
    process.env.PUBLIC_CANARY_RECEIPT_PATH ?? "public-managed-registry-canary-receipt.json",
  );
  const runId = Number(process.env.GITHUB_RUN_ID),
    runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1
  ) {
    throw new Error("Public canary requires exact GitHub run identity.");
  }
  const repositoryId = process.env.GITHUB_REPOSITORY_ID,
    repositoryName = process.env.GITHUB_REPOSITORY;
  if (
    !/^[1-9][0-9]*$/u.test(repositoryId ?? "") ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repositoryName ?? "")
  ) {
    throw new Error("Public canary requires actual GitHub repository identity.");
  }
  const repository = Object.freeze({
    provider: "github",
    id: repositoryId,
    nameWithOwner: repositoryName,
  });
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
  const releasePackageCount = receipt.packages.length + 1;
  if (releasePackageCount !== 6) {
    throw new Error(
      "Public canary receipt does not contain exactly six release package identities.",
    );
  }
  process.stdout.write(
    `Public managed registry canary PASS: 6 exact release packages (5 Cohort + supporting MCP), receipt ${receipt.receiptDigest}.\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  await main();
}
