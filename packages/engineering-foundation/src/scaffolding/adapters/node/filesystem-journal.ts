import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type { ScaffoldPlanV1 } from "../../contract/types.js";
import { assertScaffoldPlanDigest } from "../../kernel/plan-validation.js";
import { ScaffoldError } from "../../scaffold-error.js";
import { assertSchema } from "../../../schema-catalog.js";
import { parseStrictYamlSource } from "../../../strict-yaml.js";
import { syncDirectory } from "./filesystem-path-guard.js";
import { MAX_SCAFFOLD_PLAN_BYTES } from "./node-input-loader.js";

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
  let source: string;
  try {
    const metadata = await lstat(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > MAX_SCAFFOLD_PLAN_BYTES
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        "Scaffolding recovery journal is not a bounded regular file."
      );
    }
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
  const value = parseStrictYamlSource(source, "scaffold-recovery-journal");
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
      "Scaffolding recovery journal is invalid."
    );
  }
  await assertSchema("scaffold-plan/v1", value.plan, "scaffold-recovery-journal");
  const plan = value.plan as ScaffoldPlanV1;
  assertScaffoldPlanDigest(plan);
  return plan;
}

export async function removeScaffoldJournal(path: string): Promise<void> {
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
}
