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

export async function main({
  args = process.argv.slice(2),
  qualifyPublicDocs = verifyPublicExactDocsCoordinates,
  verifyAuthoring = verifyPublishedDocumentTransactionCompatibility,
  verifyBootstrap = verifyLiveBootstrapBaselines,
  verifyScaffolding = verifyPublishedScaffoldingCompatibility,
  verifyTransactions = verifyOldFoundationTransactionBarrier,
  write = (line) => process.stdout.write(line),
} = {}) {
  const temporaryRoot = await mkdtemp(
    resolve(tmpdir(), "foundation-published-compatibility-e2e-"),
  );
  try {
    const bootstrapBaselines = await verifyBootstrap({ temporaryRoot });
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
      `Published compatibility PASS: verified bootstrap baselines ${bootstrapBaselines.join(", ") || "none required"}; public Docs Protocol exact-coordinate qualification ${publicDocs.status}${publicDocs.status === "deferred" ? " to required post-reconciliation public-docs-release:e2e" : ""}; current candidate matches pinned 0.12.0 outside release identity fields.\n`,
    );
    return { bootstrapBaselines, publicDocs };
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  await main();
}
