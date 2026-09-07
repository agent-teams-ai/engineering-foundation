import { runDocsCli } from "../../packages/docs-protocol/dist/features/docs-command/composition/cli.js";

const command = process.argv[2];
const consumerRoot = process.argv[3];
const supportedCommands = new Set(["doctor", "new", "recover"]);
if (!supportedCommands.has(command) || consumerRoot === undefined) {
  throw new Error("A document command and disposable consumer root are required.");
}

const baseline = {
  SIGINT: process.listenerCount("SIGINT"),
  SIGTERM: process.listenerCount("SIGTERM"),
};

async function blockUntilCancelled(signal, port) {
  if (!(signal instanceof AbortSignal)) {
    throw new Error(`${port} did not receive an AbortSignal.`);
  }
  const keepAlive = setInterval(() => {}, 1_000);
  await new Promise((resolve) => {
    signal.addEventListener("abort", resolve, { once: true });
    process.send?.({ type: "ready", port });
  });
  clearInterval(keepAlive);
  signal.throwIfAborted();
  throw new Error(`${port} ignored cancellation.`);
}

const protocol = {
  async doctorV2({ signal }) {
    return blockUntilCancelled(signal, "doctor");
  },
  async newDocumentV2({ signal }) {
    return blockUntilCancelled(signal, "new");
  },
  async recoverV2({ signal }) {
    return blockUntilCancelled(signal, "recover");
  },
};
const newOptions = command === "new"
  ? [
      "--type", "adr", "--id", "ADR-TEST", "--title", "Cancellation",
      "--owner", "test", "--summary", "Disposable cancellation fixture.",
      "--dry-run",
    ]
  : [];

process.exitCode = await runDocsCli([
  command,
  ...newOptions,
  "--consumer",
  consumerRoot,
  "--json",
], () => protocol);
if (
  process.listenerCount("SIGINT") !== baseline.SIGINT ||
  process.listenerCount("SIGTERM") !== baseline.SIGTERM
) {
  process.stderr.write("Docs Protocol CLI signal listeners leaked.\n");
  process.exitCode = 99;
}
process.disconnect?.();
