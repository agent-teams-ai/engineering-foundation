import { parseArguments } from "../../packages/engineering-foundation/dist/cli-arguments.js";
import { RunDocumentDoctor } from "../../packages/engineering-foundation/dist/document-authoring/application/use-cases/run-document-doctor.js";
import { RunDocumentNew } from "../../packages/engineering-foundation/dist/document-authoring/application/use-cases/run-document-new.js";
import { RunDocumentRecover } from "../../packages/engineering-foundation/dist/document-authoring/application/use-cases/run-document-recover.js";
import { runDocumentCommandWithComposition } from "../../packages/engineering-foundation/dist/document-command.js";

const command = process.argv[2];
const consumerRoot = process.argv[3];
const supportedCommands = new Set(["doctor", "new", "recover"]);
if (!supportedCommands.has(command) || consumerRoot === undefined) {
  throw new Error("A document command and disposable consumer root are required.");
}

const newOptions = command === "new"
  ? [
      "--type", "adr", "--id", "ADR-TEST", "--title", "Cancellation",
      "--owner", "test", "--summary", "Disposable cancellation fixture.",
    ]
  : [];
const parsed = parseArguments([
  "docs", command, ...newOptions, "--consumer", consumerRoot, "--json",
]);
const baseline = {
  SIGINT: process.listenerCount("SIGINT"),
  SIGTERM: process.listenerCount("SIGTERM"),
};
const digest = `sha256:${"a".repeat(64)}`;

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

const doctor = new RunDocumentDoctor({
  environment: {
    async inspect(_consumerRoot, signal) {
      return blockUntilCancelled(signal, "doctor.environment.inspect");
    },
  },
  async inspect() {
    return { schemaVersion: 1, state: "idle", diagnostics: [] };
  },
});

const newDocument = new RunDocumentNew({
  async inspect() {
    return { schemaVersion: 1, state: "idle", diagnostics: [] };
  },
  async plan(request) {
    return blockUntilCancelled(request.signal, "new.plan");
  },
  async apply() { throw new Error("Cancellation must happen before apply."); },
  similar: {
    async advise() { throw new Error("Cancellation must happen before advice."); },
  },
  reachability: {
    async project() { throw new Error("Cancellation must happen before reachability."); },
  },
  structure: {
    async verify() { throw new Error("Cancellation must happen before verification."); },
  },
});

const recover = new RunDocumentRecover({
  async inspect() {
    return {
      schemaVersion: 1,
      state: "recoverable",
      operationKind: "document-authoring",
      format: "document-authoring-envelope-v3",
      foundationVersion: "0.15.0",
      foundationBuildIdentity: digest,
      recovery: {
        commandId: "docs-recover",
        exactFoundationVersion: "0.15.0",
        exactFoundationBuildIdentity: digest,
      },
      diagnostics: [],
    };
  },
  async recover(request) {
    return blockUntilCancelled(request.signal, "recover.recover");
  },
});

await runDocumentCommandWithComposition(parsed, true, () => ({
  doctor,
  newDocument,
  recover,
}));
process.disconnect?.();
const leaked = process.listenerCount("SIGINT") !== baseline.SIGINT ||
  process.listenerCount("SIGTERM") !== baseline.SIGTERM;
if (leaked) {
  process.stderr.write("Document command signal listeners leaked.\n");
  process.exitCode = 99;
}
