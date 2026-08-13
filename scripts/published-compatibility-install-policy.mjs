import { rm } from "node:fs/promises";
import { join } from "node:path";

import { runNpmCommand } from "./pack-test-support.mjs";

const firstAttemptTimeoutMs = 120_000;
const retryTimeoutMs = 240_000;
const retryDelayMs = 1_000;

const wait = (delayMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

async function cleanupPartialInstall(root) {
  await rm(join(root, "node_modules"), { force: true, recursive: true });
  await rm(join(root, "package-lock.json"), { force: true });
}

export function createPublishedCompatibilityInstallPolicy({
  cleanup = cleanupPartialInstall,
  delay = wait,
  runInstall = runNpmCommand,
} = {}) {
  let retryAvailable = true;
  return async function install(args, root) {
    try {
      return await runInstall(args, root, { timeoutMs: firstAttemptTimeoutMs });
    } catch (error) {
      if (!retryAvailable || error?.timedOut !== true || error?.killed !== true) {
        throw error;
      }
      retryAvailable = false;
      await cleanup(root);
      await delay(retryDelayMs);
      return runInstall(args, root, { timeoutMs: retryTimeoutMs });
    }
  };
}
