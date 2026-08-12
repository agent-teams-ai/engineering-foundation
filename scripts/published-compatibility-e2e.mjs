import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { verifyOldFoundationTransactionBarrier } from "./old-foundation-transaction-e2e.mjs";
import { verifyPublishedScaffoldingCompatibility } from "./published-scaffolding-compatibility-e2e.mjs";

const temporaryRoot = await mkdtemp(
  resolve(tmpdir(), "foundation-published-compatibility-e2e-"),
);
try {
  const currentCliPath = resolve(
    "packages",
    "engineering-foundation",
    "dist",
    "cli.js",
  );
  await verifyOldFoundationTransactionBarrier({ currentCliPath });
  await verifyPublishedScaffoldingCompatibility({
    currentPackageRoot: resolve("packages", "engineering-foundation"),
    temporaryRoot,
  });
  process.stdout.write(
    "Published ScaffoldPlan/ScaffoldReceipt compatibility PASS: current build equals pinned 0.12.0.\n",
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
