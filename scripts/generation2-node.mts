import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GENERATION2_NODE_ENV = "PACK_TEST_GENERATION2_NODE";

// Exactly one `v24.<minor>.<patch>` line, with an optional LF or CRLF terminator (Windows).
export function generation2Minor(output: string): number | undefined {
  const match = /^v24\.(\d+)\.\d+(?:\r?\n)?$/u.exec(output);
  return match === null ? undefined : Number(match[1]);
}

// Managed generation2 adapters (check/plan/apply) accept only Node >=24.18.0 <25
// at runtime, so their CLIs must run on an explicit Node 24 rather than on the
// Node 26 repository default.
export async function resolveGeneration2Node(
  env: NodeJS.ProcessEnv = process.env,
  current: string = process.execPath,
): Promise<string> {
  const declared = env[GENERATION2_NODE_ENV];
  const node = declared === undefined || declared === "" ? current : declared;
  if (!isAbsolute(node)) {
    throw new Error(`${GENERATION2_NODE_ENV} must be an absolute Node executable path.`);
  }
  const { stdout } = await execFileAsync(node, ["--version"], { timeout: 30_000, windowsHide: true });
  const minor = generation2Minor(stdout);
  if (minor === undefined || minor < 18) {
    throw new Error(
      `Managed generation2 consumer gates require Node >=24.18.0 <25 (set ${GENERATION2_NODE_ENV}), received ${stdout.trim()}.`,
    );
  }
  return node;
}
