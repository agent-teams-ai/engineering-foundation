import { pathToFileURL } from "node:url";

const [coordinatorModulePath, consumerRoot, requestedMutation] = process.argv.slice(2);
if (
  coordinatorModulePath === undefined ||
  consumerRoot === undefined ||
  requestedMutation === undefined
) {
  throw new Error(
    "coordinator module path, consumer root, and mutation kind are required",
  );
}

const { createNodeFoundationTransactionCoordinator } = await import(
  pathToFileURL(coordinatorModulePath).href
);
const coordinator = await createNodeFoundationTransactionCoordinator(consumerRoot);
const lease = await coordinator.acquire({ requestedMutation });
process.stdout.write("READY\n");

let shutdownStarted = false;
const shutdown = async () => {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  await lease.release();
  process.exit(0);
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (source) => {
  if (source.includes("STOP")) {
    void shutdown();
  }
});
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

process.stdin.resume();
