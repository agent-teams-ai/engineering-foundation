import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  requirePublicDocsDecision,
  verifyPublicExactDocsCoordinates,
} from "./public-docs-install-e2e.mjs";

export async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "public-docs-documented-e2e-"));
  try {
    const decision = requirePublicDocsDecision(
      await verifyPublicExactDocsCoordinates({ temporaryRoot, selection: "documented" }),
      { required: true },
    );
    process.stdout.write(
      JSON.stringify({ qualification: "documented-public-docs", ...decision }, null, 2) + "\n",
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  await main();
}
