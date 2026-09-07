import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { targetIsConsumer, invalidTargetSelfCheck, targetSelfCheckMismatch } from "../../application/inspection-failures.js";
import { parseFoundationPackageSelfCheck, type FoundationPackageSelfCheck } from "../../application/package-metadata.js";
import { resolveTargetPackageRoot } from "./registry-recovery.js";
import type { ProcessRunner } from "../../application/model.js";
import type { LocalTargetReader } from "../../application/ports.js";

async function verifyTargetPackage(
  runner: ProcessRunner,
  consumerRoot: string,
  targetPath: string,
  inspectPackage: (packageRoot: string) => Promise<FoundationPackageSelfCheck>
): Promise<{ readonly targetPackageRoot: string; readonly packageVersion: string }> {
  const targetPackageRoot = await resolveTargetPackageRoot(targetPath);
  if (targetPackageRoot === consumerRoot) {
    throw targetIsConsumer();
  }
  const expected = await inspectPackage(targetPackageRoot);
  const result = await runner.run({
    command: process.execPath,
    args: [join(targetPackageRoot, "dist", "cli.js"), "self-check", "--json"],
    cwd: targetPackageRoot
  });
  let actual;
  try {
    actual = parseFoundationPackageSelfCheck(JSON.parse(result.stdout) as unknown);
  } catch (error) {
    throw invalidTargetSelfCheck(error);
  }
  if (!isDeepStrictEqual(actual, expected)) {
    throw targetSelfCheckMismatch();
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

export function createNodeLocalTargetReader(runner: ProcessRunner, inspectPackage: (packageRoot: string) => Promise<FoundationPackageSelfCheck>): LocalTargetReader {
  return {
    verify: (consumerRoot, targetPath) => verifyTargetPackage(runner, consumerRoot, targetPath, inspectPackage),
    git: (consumerRoot, targetPackageRoot) => readGitEvidence(runner, consumerRoot, targetPackageRoot)
  };
}
