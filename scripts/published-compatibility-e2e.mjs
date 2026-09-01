import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { verifyOldFoundationTransactionBarrier } from "./old-foundation-transaction-e2e.mjs";
import { verifyLiveBootstrapBaselines } from "./npm-package-bootstrap.mjs";
import {
  requirePublicDocsDecision,
  verifyPublicExactDocsCoordinates,
} from "./public-docs-install-e2e.mjs";
import { createPublishedCompatibilityInstallPolicy } from "./published-compatibility-install-policy.mjs";
import { verifyPublishedDocumentTransactionCompatibility } from "./published-document-transaction-compatibility-e2e.mjs";
import { verifyPublishedScaffoldingCompatibility } from "./published-scaffolding-compatibility-e2e.mjs";

const temporaryRoot = await mkdtemp(
  resolve(tmpdir(), "foundation-published-compatibility-e2e-"),
);
try {
  const bootstrapBaselines = await verifyLiveBootstrapBaselines({ temporaryRoot });
  const publicDocs = requirePublicDocsDecision(
    await verifyPublicExactDocsCoordinates(
      { temporaryRoot },
      { observationAttempts: process.argv.includes("--require-public-docs") ? 5 : 1 },
    ),
    { required: process.argv.includes("--require-public-docs") },
  );
  const installPackage = createPublishedCompatibilityInstallPolicy();
  const currentCliPath = resolve(
    "packages",
    "engineering-foundation",
    "dist",
    "cli.js",
  );
  await verifyOldFoundationTransactionBarrier({ currentCliPath, installPackage });
  await verifyPublishedDocumentTransactionCompatibility({
    installPackage,
    temporaryRoot,
  });
  await verifyPublishedScaffoldingCompatibility({
    currentPackageRoot: resolve("packages", "engineering-foundation"),
    currentRuntimePackageRoot: resolve("packages", "repository-mutation"),
    installPackage,
    temporaryRoot,
  });
  process.stdout.write(
    `Published compatibility PASS: verified bootstrap baselines ${bootstrapBaselines.join(", ") || "none required"}; public Docs Protocol exact-coordinate qualification ${publicDocs.status}; current candidate matches pinned 0.12.0 outside release identity fields.\n`,
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
