import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [
  modulePath,
  consumerRoot,
  planPath,
  functionName,
  expectedPhase,
  expectedIndexSource
] = process.argv.slice(2);
if (
  modulePath === undefined ||
  consumerRoot === undefined ||
  planPath === undefined ||
  functionName === undefined ||
  expectedPhase === undefined
) {
  throw new Error(
    "module path, consumer root, Plan path, function name, and fault phase are required"
  );
}

const expectedIndex =
  expectedIndexSource === undefined ? undefined : Number(expectedIndexSource);
const workspace = await import(pathToFileURL(modulePath).href);
const applyWithFaultInjection = workspace[functionName];
if (typeof applyWithFaultInjection !== "function") {
  throw new Error("workspace module does not expose a fault-injection seam");
}
const plan = JSON.parse(await readFile(planPath, "utf8"));

await applyWithFaultInjection(
  consumerRoot,
  plan,
  (point) => {
    if (
      point.phase === expectedPhase &&
      (expectedIndex === undefined || point.operationIndex === expectedIndex)
    ) {
      process.stdout.write("FOUNDATION_CRASH_POINT\n");
      return new Promise(() => {
        setInterval(() => {}, 60_000);
      });
    }
  }
);

throw new Error(`Fault point was not reached: ${expectedPhase}.`);
