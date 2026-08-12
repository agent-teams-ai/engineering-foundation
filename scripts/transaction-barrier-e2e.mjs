import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { captureFailure, runCommand } from "./pack-test-support.mjs";

const unknownTransactionBytes = Buffer.from(
  '{"schemaVersion":99,"owner":"foreign-writer","opaque":[1,2,3]}\n',
  "utf8",
);

async function assertAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`Foreign transaction did not block target publication: ${path}.`);
}

export async function verifyInstalledTransactionBarrier({
  cliPath,
  consumerRoot,
  fixtureRoot,
}) {
  await cp(fixtureRoot, consumerRoot, { recursive: true });
  const { stdout: planOutput } = await runCommand(
    process.execPath,
    [
      cliPath,
      "scaffold-plan",
      "intents/create-fixture.yaml",
      "--consumer",
      consumerRoot,
      "--json",
    ],
    consumerRoot,
  );
  const plan = JSON.parse(planOutput);
  const planPath = join(consumerRoot, "plans", "transaction-barrier.json");
  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(planPath, planOutput, "utf8");
  const planBefore = await readFile(planPath);

  const transactionPath = join(
    consumerRoot,
    ".agent-teams-local",
    "scaffolding-transaction.json",
  );
  await mkdir(dirname(transactionPath), { recursive: true });
  await writeFile(transactionPath, unknownTransactionBytes);
  const transactionBefore = await readFile(transactionPath);

  const mutationFailure = await captureFailure(() =>
    runCommand(
      process.execPath,
      [
        cliPath,
        "scaffold-apply",
        "plans/transaction-barrier.json",
        "--consumer",
        consumerRoot,
        "--json",
      ],
      consumerRoot,
    ),
  );
  if (
    mutationFailure?.code !== 1 ||
    mutationFailure.stdout !== "" ||
    !/SCAFFOLD_RECOVERY_REQUIRED/u.test(mutationFailure.stderr)
  ) {
    throw new Error("Installed package did not fail closed on a foreign transaction.");
  }
  if (!(await readFile(transactionPath)).equals(transactionBefore)) {
    throw new Error("Installed package changed foreign transaction evidence.");
  }
  if (!(await readFile(planPath)).equals(planBefore)) {
    throw new Error("Installed package changed the reviewed Plan while blocked.");
  }
  await assertAbsent(join(consumerRoot, plan.target.path));

  const observedStatus = await captureFailure(() =>
    runCommand(
      process.execPath,
      [cliPath, "status", "--consumer", consumerRoot, "--json"],
      consumerRoot,
    ),
  );
  if (observedStatus?.code !== 1) {
    throw new Error("Installed status did not fail for a foreign transaction.");
  }
  if (observedStatus.stderr !== "") {
    throw new Error("Installed status JSON emitted an unexpected stderr payload.");
  }
  let status;
  try {
    status = JSON.parse(observedStatus.stdout);
  } catch (error) {
    throw new Error("Installed status diagnostics are not one parseable JSON value.", {
      cause: error,
    });
  }
  if (
    status.transaction?.state !== "manual-recovery-required" ||
    status.transaction.diagnostics?.[0]?.code !==
      "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED"
  ) {
    throw new Error("Installed status omitted the foreign transaction diagnostic.");
  }
  if (!(await readFile(transactionPath)).equals(transactionBefore)) {
    throw new Error("Installed status inspection changed foreign transaction evidence.");
  }

  await rm(transactionPath);
}
