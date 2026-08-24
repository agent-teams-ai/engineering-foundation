import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compileKnownFileTransactionPlan } from "../../packages/engineering-foundation/dist/mutation/index.js";

export const posixTest = process.platform === "win32" ? test.skip : test;
export const windowsTest = process.platform === "win32" ? test : test.skip;
const crashWorker = fileURLToPath(new URL(
  "../fixtures/known-file-transaction-crash-worker.mjs",
  import.meta.url,
));

export async function temporaryDirectory(context, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(async () => {
    await rm(root, { force: true, recursive: true });
  });
  return root;
}
export async function fixture(context) {
  const root = await temporaryDirectory(context, "foundation-known-file-");
  await mkdir(join(root, "managed"));
  await writeFile(join(root, "managed", "existing.txt"), "old\n", { mode: 0o640 });
  return root;
}

export async function killAtCheckpoint(root, checkpoint, action = "apply") {
  const child = spawn(process.execPath, [crashWorker, root, checkpoint, action], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise((resolve) => { child.once("exit", resolve); });
  let output = "";
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`checkpoint timeout: ${checkpoint}`)), 30_000);
      child.once("error", reject);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes(`${checkpoint}\n`)) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    throw error;
  }
  assert.equal(child.kill("SIGKILL"), true);
  await exited;
}

export function plan() {
  return compileKnownFileTransactionPlan({ operations: [
    {
      path: "managed/existing.txt",
      precondition: {
        state: "known-file",
        acceptedPreimages: [{ bytes: Buffer.from("old\n"), mode: 0o640 }],
      },
      postimage: { bytes: Buffer.from("new\n"), mode: 0o640 },
    },
    {
      path: "managed/new.txt",
      precondition: { state: "absent" },
      postimage: { bytes: Buffer.from("created\n") },
    },
  ] });
}

export function replacementPlan() {
  const operation = plan().operations[0];
  return compileKnownFileTransactionPlan({ operations: [{
    path: operation.path,
    precondition: {
      state: "known-file",
      acceptedPreimages: operation.precondition.acceptedPreimages.map((image) => ({
        bytes: Buffer.from(image.contentBase64, "base64"),
        mode: image.mode,
      })),
    },
    postimage: {
      bytes: Buffer.from(operation.postimage.contentBase64, "base64"),
      mode: operation.postimage.mode,
    },
  }] });
}
