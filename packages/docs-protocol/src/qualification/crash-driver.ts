import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

type QualificationCrashPoint =
  | "after-publishing-journal-durable"
  | "after-published-journal-durable";

const workerInvocation: Readonly<Record<QualificationCrashPoint, string>> = Object.freeze({
  "after-publishing-journal-durable":
    'await runDocumentAuthoringCrashQualification({ consumerRoot, plan, crashPoint: "after-publishing-journal-durable" });',
  "after-published-journal-durable":
    'await runDocumentAuthoringCrashQualification({ consumerRoot, plan, crashPoint: "after-published-journal-durable" });'
});

async function crashAtDurableCheckpoint(
  consumerRoot: string,
  plan: unknown,
  crashPoint: QualificationCrashPoint,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  const planPath = join(consumerRoot, ".qualification-crash-plan.json");
  const workerPath = join(consumerRoot, ".qualification-crash-worker.mjs");
  await writeFile(planPath, `${JSON.stringify(plan)}\n`, "utf8");
  await writeFile(workerPath, [
    'import { readFile } from "node:fs/promises";',
    'import { runDocumentAuthoringCrashQualification } from "@agent-teams/engineering-foundation/document-authoring/qualification";',
    "const [consumerRoot, planPath] = process.argv.slice(2);",
    'const plan = JSON.parse(await readFile(planPath, "utf8"));',
    workerInvocation[crashPoint],
    ""
  ].join("\n"), "utf8");
  const child = spawn(process.execPath, [workerPath, consumerRoot, planPath], {
    cwd: consumerRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  let stdout = "";
  const crashCheckpoint = `${JSON.stringify({
    schemaVersion: 1,
    event: "document-authoring-qualification-crash-point",
    crashPoint
  })}\n`;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const terminated = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
    const settle = (code: number | null, exitSignal: NodeJS.Signals | null) => {
      resolve({ code, signal: exitSignal });
    };
    child.once("error", () => { settle(child.exitCode, child.signalCode); });
    child.once("exit", settle);
    child.once("close", settle);
  });
  const abort = () => { child.kill("SIGKILL"); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted === true) {abort();}
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => { reject(new Error(`Qualification crash driver did not reach ${crashPoint}: ${stderr}`)); }, 30_000);
      const cancelled = () => {
        clearTimeout(deadline);
        reject(signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("Docs Protocol qualification was cancelled.", "AbortError"));
      };
      signal?.addEventListener("abort", cancelled, { once: true });
      if (signal?.aborted === true) {
        cancelled();
        return;
      }
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes(crashCheckpoint)) {
          clearTimeout(deadline);
          signal?.removeEventListener("abort", cancelled);
          resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", cancelled);
        reject(error);
      });
      child.once("exit", (code, exitSignal) => {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", cancelled);
        reject(new Error(`Qualification crash driver exited before checkpoint: ${code}/${exitSignal}: ${stderr}`));
      });
    });
    signal?.throwIfAborted();
    if (!child.kill("SIGKILL")) {throw new Error("Qualification could not terminate its disposable crash driver.");}
    const termination = await terminated;
    if (termination.signal !== "SIGKILL") {
      throw new Error(`Qualification crash driver did not terminate through SIGKILL: ${termination.code}/${termination.signal}.`);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await terminated;
    }
    await rm(workerPath, { force: true });
    await rm(planPath, { force: true });
  }
}

export async function crashAtDurablePublishing(
  consumerRoot: string,
  plan: unknown,
  signal?: AbortSignal
): Promise<void> {
  return crashAtDurableCheckpoint(
    consumerRoot,
    plan,
    "after-publishing-journal-durable",
    signal
  );
}

export async function crashAfterDurablePublication(
  consumerRoot: string,
  plan: unknown,
  signal?: AbortSignal
): Promise<void> {
  return crashAtDurableCheckpoint(
    consumerRoot,
    plan,
    "after-published-journal-durable",
    signal
  );
}
