import { pathToFileURL } from "node:url";

const [serviceModulePath, consumerRoot] = process.argv.slice(2);
if (serviceModulePath === undefined || consumerRoot === undefined) {
  throw new Error("service module path and consumer root are required");
}

const { acquireFoundationOperationLock } = await import(
  pathToFileURL(serviceModulePath).href
);
const release = await acquireFoundationOperationLock(consumerRoot);
process.stdout.write("READY\n");

const shutdown = async () => {
  await release();
  process.exit(0);
};
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

setInterval(() => {}, 60_000);
