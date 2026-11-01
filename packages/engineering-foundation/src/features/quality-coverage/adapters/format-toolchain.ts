import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseStrictJson } from "@agent-teams/repository-mutation/serialization";
import {
  assertNotCancelled,
  rejectFormatCoverage,
  formatPublicEntryTarget,
  type FormatCoveragePorts,
  type QualityFileReader,
} from "../api.js";
import { qualityRecord } from "./profile-input.js";
import { inspectConsumerStackPackage } from "./consumer-toolchain.js";

const digest = (paths: readonly string[]) =>
  createHash("sha256").update(JSON.stringify(paths)).digest("hex");
const within = (root: string, file: string) => {
  const path = relative(root, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const stringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((file: unknown) => typeof file === "string");
const samePaths = (expected: readonly string[], value: unknown): boolean =>
  stringArray(value) &&
  value.length === expected.length &&
  expected.every((path, index) => value[index] === path);
const callable = (
  value: unknown,
): value is (input: {
  readonly command: "format:check";
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly budgetMs: number;
  readonly formatFiles: readonly string[];
}) => Promise<unknown> => typeof value === "function";

export function createLiteralFormatter(
  read: QualityFileReader,
): FormatCoveragePorts["prepareFormatter"] {
  return async (consumerRoot, signal) => {
    assertNotCancelled(signal);
    const root = await realpath(consumerRoot);
    const manifest = await inspectConsumerStackPackage(root, read);
    const packageRoot = dirname(manifest);
    const json = async (file: string) =>
      qualityRecord(
        parseStrictJson(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await read({ root, candidate: file, maxBytes: 2 * 1024 * 1024 }),
          ),
        ),
      );
    const metadata = await json(manifest);
    const exports = qualityRecord(metadata["exports"]);
    const rootExport = qualityRecord(exports["."]);
    if (Object.keys(rootExport).some((key) => key !== "types" && key !== "import")) {
      rejectFormatCoverage("Unsupported Stack public ESM export conditions.");
    }
    const target = rootExport["import"];
    if (typeof target !== "string" || !target.startsWith("./")) {
      rejectFormatCoverage("Stack must expose its public ESM entrypoint.");
    }
    const publicTarget = formatPublicEntryTarget(target);
    if (publicTarget === undefined) {
      rejectFormatCoverage("Invalid Stack public ESM target.");
    }
    const entry = await realpath(join(packageRoot, publicTarget));
    const pins = await realpath(
      createRequire(join(root, "package.json")).resolve("stack-toolchain/toolchain-manifest.json"),
    );
    if (!within(packageRoot, entry) || !within(packageRoot, pins)) {
      rejectFormatCoverage("Stack public exports escape the selected physical package.");
    }
    await read({ root, candidate: entry, maxBytes: 4 * 1024 * 1024 });
    const versions = await json(pins);
    if (
      versions["schemaVersion"] !== 1 ||
      typeof versions["oxfmt"] !== "string" ||
      versions["oxfmt"] !== qualityRecord(metadata["dependencies"])["oxfmt"]
    ) {
      rejectFormatCoverage("Unsupported or inconsistent Stack version manifest.");
    }
    const module: unknown = await import(pathToFileURL(entry).href);
    const api = qualityRecord(module);
    const run = api["runCommand"];
    if (api["formatFilesContractVersion"] !== 1 || !callable(run)) {
      rejectFormatCoverage("Installed Stack lacks public literal format contract1.");
    }
    assertNotCancelled(signal);
    return async (files, executionSignal, budgetMs) => {
      const expected = Object.freeze([...files].toSorted());
      const report = qualityRecord(
        await run({
          command: "format:check",
          cwd: root,
          signal: executionSignal,
          budgetMs,
          formatFiles: Object.freeze([...expected]),
        }),
      );
      const details = qualityRecord(report["details"]);
      const hashes = qualityRecord(details["digests"]);
      if (
        report["command"] !== "format:check" ||
        report["status"] !== "passed" ||
        report["exitCode"] !== 0 ||
        details["schemaVersion"] !== 1 ||
        details["completed"] !== true ||
        details["sourceBytesUnchanged"] !== true ||
        details["failure"] !== undefined ||
        details["retainedControlDirectory"] !== undefined
      ) {
        rejectFormatCoverage("Stack literal execution did not complete safely.");
      }
      for (const key of ["requested", "validated", "attempted"]) {
        if (!samePaths(expected, details[key]) || hashes[key] !== digest(expected)) {
          rejectFormatCoverage(
            "Stack literal selection or digest differs from the full expected set.",
          );
        }
      }
      const batches = details["batches"];
      if (!Array.isArray(batches) || batches.length === 0) {
        rejectFormatCoverage("Missing literal batch evidence.");
      }
      const attempted: string[] = [];
      for (const value of batches) {
        const batch = qualityRecord(value);
        const batchFiles = batch["files"];
        if (
          batch["completed"] !== true ||
          qualityRecord(batch["result"])["exitCode"] !== 0 ||
          !stringArray(batchFiles) ||
          batchFiles.length === 0
        ) {
          rejectFormatCoverage("Literal batch was incomplete or failed.");
        }
        attempted.push(...batchFiles);
      }
      if (!samePaths(expected, attempted)) {
        rejectFormatCoverage("Literal batches omitted or duplicated expected inputs.");
      }
      assertNotCancelled(executionSignal);
    };
  };
}
