import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { FoundationError } from "../../application/errors/foundation-error.js";
import { inspectFoundationPackage } from "./package-inspection.js";
import { parseFoundationPackageSelfCheck } from "../../application/package-metadata.js";
import { resolveTargetPackageRoot } from "./registry-recovery.js";
import type { ProcessRunner } from "../../application/model.js";
import type { LocalTargetReader } from "../../application/ports.js";

async function verifyTargetPackage(
  runner: ProcessRunner,
  consumerRoot: string,
  targetPath: string
): Promise<{ readonly targetPackageRoot: string; readonly packageVersion: string }> {
  const targetPackageRoot = await resolveTargetPackageRoot(targetPath);
  if (targetPackageRoot === consumerRoot) {
    throw new FoundationError("PACKAGE_INVALID", "Foundation target cannot be the consumer repository.");
  }
  const expected = await inspectFoundationPackage(targetPackageRoot);
  const result = await runner.run({
    command: process.execPath,
    args: [join(targetPackageRoot, "dist", "cli.js"), "self-check", "--json"],
    cwd: targetPackageRoot
  });
  let actual;
  try {
    actual = parseFoundationPackageSelfCheck(JSON.parse(result.stdout) as unknown);
  } catch (error) {
    throw new FoundationError(
      "PACKAGE_INVALID",
      "Foundation target CLI self-check did not return a valid result.",
      { cause: error }
    );
  }
  if (!isDeepStrictEqual(actual, expected)) {
    throw new FoundationError(
      "PACKAGE_INVALID",
      "Foundation target CLI self-check disagrees with package metadata."
    );
  }
  return { targetPackageRoot, packageVersion: expected.packageVersion };
}

async function readGitEvidence(
  runner: ProcessRunner,
  consumerRoot: string,
  targetPackageRoot: string
): Promise<{ readonly gitCommit: string; readonly gitDirty: boolean }> {
  const gitCommit = (await runner.run({
    command: "git",
    args: ["-C", targetPackageRoot, "rev-parse", "HEAD"],
    cwd: consumerRoot
  })).stdout.trim();
  const gitDirty = (await runner.run({
    command: "git",
    args: ["-C", targetPackageRoot, "status", "--porcelain"],
    cwd: consumerRoot
  })).stdout.trim().length > 0;
  return { gitCommit, gitDirty };
}

export function createNodeLocalTargetReader(runner: ProcessRunner): LocalTargetReader {
  return {
    verify: (consumerRoot, targetPath) => verifyTargetPackage(runner, consumerRoot, targetPath),
    git: (consumerRoot, targetPackageRoot) => readGitEvidence(runner, consumerRoot, targetPackageRoot)
  };
}
