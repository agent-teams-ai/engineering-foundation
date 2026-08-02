import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [modulePath, consumerRoot, planPath, expectedPhase, expectedIndexSource] =
  process.argv.slice(2);
if (
  modulePath === undefined ||
  consumerRoot === undefined ||
  planPath === undefined ||
  expectedPhase === undefined
) {
  throw new Error(
    "module path, consumer root, Plan path, and fault phase are required"
  );
}

const expectedIndex =
  expectedIndexSource === undefined ? undefined : Number(expectedIndexSource);
const { applyFilesystemScaffoldWithFaultInjection } = await import(
  pathToFileURL(modulePath).href
);
const plan = JSON.parse(await readFile(planPath, "utf8"));

await applyFilesystemScaffoldWithFaultInjection(
  consumerRoot,
  plan,
  (point) => {
    if (
      point.phase === expectedPhase &&
      (expectedIndex === undefined || point.operationIndex === expectedIndex)
    ) {
      process.stdout.write("FOUNDATION_CRASH_POINT\n");
      return new Promise(() => {});
    }
  }
);

throw new Error(`Fault point was not reached: ${expectedPhase}.`);
