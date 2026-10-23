import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { verifyOldFoundationTransactionBarrier } from "./old-foundation-transaction-e2e.mjs";
import { NPM_PACKAGE_BOOTSTRAP, verifyLiveBootstrapBaselines } from "./npm-package-bootstrap.mjs";
import { fail } from "./npm-package-bootstrap-catalog.mjs";
import {
  requirePublicDocsDecision,
  verifyPublicExactDocsCoordinates,
} from "./public-docs-install-e2e.mjs";
import { createPublishedCompatibilityInstallPolicy } from "./published-compatibility-install-policy.mjs";
import { verifyPublishedDocumentTransactionCompatibility } from "./published-document-transaction-compatibility-e2e.mjs";
import { verifyPublishedScaffoldingCompatibility } from "./published-scaffolding-compatibility-e2e.mjs";

// Admission and approval PRs precede the first protected bootstrap publication.
// Historical compatibility reports those source baselines as pending; release
// and publication retain the separate complete-catalog approval requirement.
export async function verifyPublishedCompatibilityBootstrapBaselines({
  auditPackage,
  catalog = NPM_PACKAGE_BOOTSTRAP,
  fetchImplementation,
  observationOptions,
  readManifest = async (path) => JSON.parse(await readFile(path, "utf8")),
  temporaryRoot,
} = {}) {
  const profiles = [];
  const manifests = new Map();
  const pending = [];
  for (const profile of catalog.packages) {
    const manifest = await readManifest(resolve(profile.manifestPath));
    if (manifest?.name !== profile.name || typeof manifest.version !== "string") {
      fail(`${profile.manifestPath} does not match bootstrap catalog identity.`);
    }
    manifests.set(resolve(profile.manifestPath), manifest);
    if (profile.state === "candidate") {
      if (profile.approval !== null || profile.bootstrapVersion !== "0.0.0" || manifest.version !== profile.bootstrapVersion) {
        fail(`${profile.name} compatibility candidate must retain its unapproved 0.0.0 bootstrap identity.`);
      }
    } else {
      profiles.push(profile);
    }
    if (manifest.version === profile.bootstrapVersion) {
      pending.push(`${profile.name}@${profile.bootstrapVersion}`);
    }
  }
  const verified = await verifyLiveBootstrapBaselines({
    auditPackage,
    catalog: Object.freeze({ ...catalog, packages: Object.freeze(profiles) }),
    fetchImplementation,
    observationOptions,
    readManifest: async (path) => manifests.get(path),
    temporaryRoot,
  });
  return Object.freeze({ pending: Object.freeze(pending), verified });
}

export async function main({
  args = process.argv.slice(2),
  qualifyPublicDocs = verifyPublicExactDocsCoordinates,
  verifyAuthoring = verifyPublishedDocumentTransactionCompatibility,
  verifyBootstrap = verifyPublishedCompatibilityBootstrapBaselines,
  verifyScaffolding = verifyPublishedScaffoldingCompatibility,
  verifyTransactions = verifyOldFoundationTransactionBarrier,
  removeTemporaryRoot = rm,
  write = (line) => process.stdout.write(line),
} = {}) {
  const temporaryRoot = await mkdtemp(
    resolve(tmpdir(), "foundation-published-compatibility-e2e-"),
  );
  const failures = [];
  let result;
  try {
    const { pending: pendingBootstrapBaselines, verified: bootstrapBaselines } = await verifyBootstrap({ temporaryRoot });
    // Current public completion depends on the ordered publisher reconciling GitHub.
    // CI and release preflight still require every historical compatibility check.
    const publicDocs = args.includes("--require-public-docs")
      ? requirePublicDocsDecision(
        await qualifyPublicDocs({ temporaryRoot }, { observationAttempts: 5 }),
        { required: true },
      )
      : { status: "deferred" };
    const installPackage = createPublishedCompatibilityInstallPolicy();
    const currentCliPath = resolve(
      "packages",
      "engineering-foundation",
      "dist",
      "cli.js",
    );
    await verifyTransactions({ currentCliPath, installPackage });
    await verifyAuthoring({
      installPackage,
      temporaryRoot,
    });
    await verifyScaffolding({
      currentAuthoringPackageRoot: resolve("packages", "document-authoring"),
      currentPackageRoot: resolve("packages", "engineering-foundation"),
      currentRuntimePackageRoot: resolve("packages", "repository-mutation"),
      installPackage,
      temporaryRoot,
    });
    write(
      `Published compatibility PASS: verified bootstrap baselines ${bootstrapBaselines.join(", ") || "none required"}; pending bootstrap baseline qualification (publication unclaimed) ${pendingBootstrapBaselines.join(", ") || "none"}; public Docs Protocol exact-coordinate qualification ${publicDocs.status}${publicDocs.status === "deferred" ? " to required post-reconciliation public-docs-release:e2e" : ""}; published operation boundaries 0.11.0/0.12.0/0.14.0 preserved; current CLI matches the published 0.12.0 scaffolding operations outside release identity fields.\n`,
    );
    result = { bootstrapBaselines, pendingBootstrapBaselines, publicDocs };
  } catch (error) {
    failures.push(error);
  } finally {
    try { await removeTemporaryRoot(temporaryRoot, { force: true, recursive: true }); }
    catch (error) { failures.push(error); }
  }
  if (failures.length === 1) { throw failures[0]; }
  if (failures.length > 1) { throw new AggregateError(failures, "Published compatibility and cleanup failed.", { cause: failures[0] }); }
  return result;
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  await main();
}
