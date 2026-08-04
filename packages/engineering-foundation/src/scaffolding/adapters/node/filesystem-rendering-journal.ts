import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type { ScaffoldPlanV1 } from "../../contract/types.js";
import { assertScaffoldPlanDigest } from "../../kernel/rendering-plan-validation.js";
import { ScaffoldError } from "../../scaffold-error.js";
import { assertSchema } from "../../../schema-catalog.js";
import { parseStrictYamlSource } from "../../../strict-yaml.js";
import { readBoundedRegularFile } from "./filesystem-file-identity.js";
import { syncDirectory } from "./filesystem-path-guard.js";
import { MAX_SCAFFOLD_PLAN_BYTES } from "./node-scaffold-limits.js";

export const SCAFFOLD_JOURNAL_FILE = "scaffolding-transaction.json";

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function writeScaffoldJournal(
  path: string,
  plan: ScaffoldPlanV1
): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporary = `${path}.tmp`;
  await rm(temporary, { force: true });
  let renamed = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      const journal = { schemaVersion: 1, state: "PREPARED", plan };
      await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    renamed = true;
    await syncDirectory(parent);
  } finally {
    if (!renamed) {
      await rm(temporary, { force: true });
    }
  }
}

export async function readScaffoldJournal(
  path: string
): Promise<ScaffoldPlanV1 | undefined> {
  try {
    const result = await readBoundedRegularFile(path, MAX_SCAFFOLD_PLAN_BYTES);
    if (result.outcome === "invalid") {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        "Scaffolding recovery journal is not a bounded regular file."
      );
    }
    if (result.outcome === "changed") {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        "Scaffolding recovery journal changed while it was being read."
      );
    }
    const value = parseStrictYamlSource(
      result.bytes.toString("utf8"),
      "rendering-regression-journal"
    );
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 3 ||
      !("schemaVersion" in value) ||
      value.schemaVersion !== 1 ||
      !("state" in value) ||
      value.state !== "PREPARED" ||
      !("plan" in value)
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        "The 0.5 regression adapter cannot recover this scaffolding journal."
      );
    }
    await assertSchema(
      "scaffold-plan/v1",
      value.plan,
      "rendering-regression-journal"
    );
    const plan = value.plan as ScaffoldPlanV1;
    assertScaffoldPlanDigest(plan);
    return plan;
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function removeScaffoldJournal(
  path: string,
  faultInjector?: () => Promise<void> | void
): Promise<void> {
  await rm(path, { force: true });
  await faultInjector?.();
  await syncDirectory(dirname(path));
}
