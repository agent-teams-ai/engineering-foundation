import { parseArguments } from "../../packages/engineering-foundation/dist/cli-arguments.js";
import { RunDocumentDoctor } from "../../packages/engineering-foundation/dist/document-authoring/application/use-cases/run-document-doctor.js";
import { runDocumentCommandWithComposition } from "../../packages/engineering-foundation/dist/document-command.js";

const consumerRoot = process.argv[2];
if (consumerRoot === undefined) {
  throw new Error("A disposable consumer root is required.");
}

const parsed = parseArguments([
  "docs",
  "doctor",
  "--consumer",
  consumerRoot,
  "--json",
]);
const baseline = {
  SIGINT: process.listenerCount("SIGINT"),
  SIGTERM: process.listenerCount("SIGTERM"),
};

const doctor = new RunDocumentDoctor({
  environment: {
    async inspect(_consumerRoot, signal) {
      const keepAlive = setInterval(() => {}, 1_000);
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
        process.send?.({ type: "ready" });
      });
      clearInterval(keepAlive);
      signal.throwIfAborted();
      throw new Error("The controlled cancellation must stop environment inspection.");
    },
  },
  async inspect() {
    return { schemaVersion: 1, state: "idle", diagnostics: [] };
  },
});

function createControlledCommands() {
  return {
    doctor: {
      async execute(request) {
        return doctor.execute(request);
      },
    },
    newDocument: { async execute() { throw new Error("Unexpected docs new."); } },
    recover: { async execute() { throw new Error("Unexpected docs recover."); } },
  };
}

await runDocumentCommandWithComposition(parsed, true, createControlledCommands);
process.disconnect?.();
const leaked = process.listenerCount("SIGINT") !== baseline.SIGINT ||
  process.listenerCount("SIGTERM") !== baseline.SIGTERM;
if (leaked) {
  process.stderr.write("Document command signal listeners leaked.\n");
  process.exitCode = 99;
}
