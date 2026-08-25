import { runDocsCli } from "../../dist/composition/cli.js";

const baseline = {
  SIGINT: process.listenerCount("SIGINT"),
  SIGTERM: process.listenerCount("SIGTERM"),
};

const protocol = {
  async info({ signal }) {
    if (!(signal instanceof AbortSignal)) {
      throw new Error("Docs CLI did not pass an AbortSignal.");
    }
    const keepAlive = setInterval(() => {}, 1_000);
    const cancelled = new Promise((resolve) => {
      signal.addEventListener("abort", resolve, { once: true });
    });
    process.send?.({ type: "ready" });
    await cancelled;
    clearInterval(keepAlive);
    signal.throwIfAborted();
  },
};

process.exitCode = await runDocsCli(["info", "--json"], () => protocol);
if (process.listenerCount("SIGINT") !== baseline.SIGINT || process.listenerCount("SIGTERM") !== baseline.SIGTERM) {
  process.stderr.write("Docs CLI signal listeners leaked.\n");
  process.exitCode = 99;
}
