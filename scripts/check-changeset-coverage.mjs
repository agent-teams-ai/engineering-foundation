import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const changesetsCli = require.resolve("@changesets/cli/bin.js");
const EXACT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function exactCommitSha(value, label = "base revision") {
  if (typeof value !== "string" || !EXACT_SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact 40-character lowercase commit SHA`);
  }
  return value;
}

export async function checkChangesetCoverage({ baseRevision, cwd = process.cwd() }) {
  const base = exactCommitSha(baseRevision);
  try {
    return await execFileAsync(
      process.execPath,
      [changesetsCli, "status", `--since=${base}`],
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
        windowsHide: true,
      },
    );
  } catch (error) {
    const details = [error?.stdout, error?.stderr]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .join("\n")
      .trim();
    throw new Error(
      details.length > 0
        ? `Changeset coverage failed:\n${details}`
        : "Changeset coverage failed without diagnostic output",
      { cause: error },
    );
  }
}

async function main() {
  const baseRevision =
    argumentValue("--base") ?? process.env.FOUNDATION_CHANGESET_BASE_SHA;
  const result = await checkChangesetCoverage({ baseRevision });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  await main();
}
