import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const COMMAND_LAUNCH_TIMEOUT_MS = 30_000;
const WRAPPER_EXIT_MARKER_GRACE_MS = 1_000;
const LAUNCH_POLL_INTERVAL_MS = 10;

/** Host-private protocol: a wrapper spawn is not proof of a command launch. */
export async function waitForWindowsCommandLaunch(
  child: Pick<ChildProcess, "exitCode" | "signalCode">,
  launchPath: string,
  shouldStopWaiting: () => boolean
): Promise<void> {
  const deadline = performance.now() + COMMAND_LAUNCH_TIMEOUT_MS;
  let exitObservedAt: number | undefined;
  for (;;) {
    // Hand interruption back to the generic executor without classifying it.
    if (shouldStopWaiting()) { return; }
    let marker: string | undefined;
    try {
      marker = await readFile(launchPath, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    if (marker === "STARTED") { return; }
    if (marker === "FAILED") {
      throw new Error("The contained Windows command could not be started.");
    }
    if (marker !== undefined && marker !== "") {
      throw new Error("The contained Windows command sent an invalid launch confirmation.");
    }
    const now = performance.now();
    if (child.exitCode !== null || child.signalCode !== null) {
      exitObservedAt ??= now;
      if (now - exitObservedAt >= WRAPPER_EXIT_MARKER_GRACE_MS) {
        throw new Error("The Windows wrapper exited without a command launch confirmation.");
      }
    }
    if (now >= deadline) {
      throw new Error("The Windows command launch confirmation timed out.");
    }
    await delay(Math.min(LAUNCH_POLL_INTERVAL_MS, deadline - now));
  }
}
