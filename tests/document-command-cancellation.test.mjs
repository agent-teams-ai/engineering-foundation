import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertDocsCommandEnvelopeSchema } from "../packages/docs-protocol/dist/adapters/docs-command-envelope-schema-validator.js";

const childPath = fileURLToPath(new URL(
  "fixtures/document-command-cancellation-child.mjs",
  import.meta.url,
));

async function collectCancellation(command, signal) {
  const consumerRoot = await mkdtemp(join(tmpdir(), "foundation-docs-cancel-"));
  const child = fork(childPath, [command, consumerRoot], {
    execArgv: [],
    silent: true,
  });
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.on("message", (message) => {
        if (message?.type === "ready") {
          resolve();
        }
      });
    });
    assert.equal(child.kill(signal), true);
    const result = await new Promise((resolve) => {
      child.once("close", (code, closeSignal) => {
        resolve({ code, signal: closeSignal });
      });
    });
    return { result, stderr, stdout };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await rm(consumerRoot, { force: true, recursive: true });
  }
}

for (const command of ["doctor", "new", "recover"]) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    test(`${signal} cancels docs ${command} through the CLI boundary`, {
      skip: process.platform === "win32",
      timeout: 10_000,
    }, async () => {
      const { result, stderr, stdout } = await collectCancellation(
        command,
        signal,
      );
      assert.deepEqual(result, { code: 130, signal: null });
      assert.equal(stderr, "");
      const envelope = JSON.parse(stdout);
      assert.equal(`${JSON.stringify(envelope)}\n`, stdout);
      assert.equal(envelope.command, `docs.${command}`);
      assert.equal(envelope.outcome, "cancelled");
      await assertDocsCommandEnvelopeSchema(envelope);
    });
  }
}
