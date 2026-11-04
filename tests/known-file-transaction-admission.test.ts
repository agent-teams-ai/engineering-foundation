import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertCompatibleKnownFileInputs,
  assertInertKnownFileInputs,
  assertKnownFileInputBudgets,
  assertOwnedKnownFilePlan,
} from "../packages/repository-mutation/tests/public-contract.ts";

await test("public compiler and wire admission reject executable data without invoking it", () => {
  assertInertKnownFileInputs();
});

await test("public compilation preserves supported inert data, optional modes and owned byte views", () => {
  assertCompatibleKnownFileInputs();
});

await test("public admission preflights whole operation, preimage and raw-byte budgets", () => {
  assertKnownFileInputBudgets();
});

await test("public apply binds effects and early replay receipts to its pre-await owned Plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "known-file-admission-"));
  try {
    await assertOwnedKnownFilePlan(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
