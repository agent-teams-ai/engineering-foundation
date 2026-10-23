import { lstat, realpath } from "node:fs/promises";
import { readContractFile } from "./contract-file.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { run } from "node:test";
import { fail, validateNodeTestContract } from "./contract-validation.js";
export { validateNodeTestContract } from "./contract-validation.js";
import {
  collectEvent,
  observedEntries,
  countProtected,
  type Evidence,
  type Event,
  type Selected,
} from "./event-evidence.js";
import { boundedText, nodeTestFailureDetail, testNameLimit } from "./failure-diagnostics.js";

async function selectFiles(root: string, files: string[]): Promise<Selected[]> {
  if (!Array.isArray(files) || files.length === 0) {
    fail("selected files must be nonempty");
  }
  const selected: Selected[] = [];
  const seen = new Set<string>();
  for (const path of files) {
    if (typeof path !== "string" || path.length === 0) {
      fail("selected file must be a path");
    }
    const absolute = resolve(root, path);
    const file = relative(root, absolute).split(sep).join("/");
    if (
      !file ||
      file.startsWith("../") ||
      isAbsolute(file) ||
      file.includes("\\") ||
      file !== file.normalize("NFC") ||
      seen.has(file)
    ) {
      fail(`invalid selected file ${path}`);
    }
    seen.add(file);
    if (!(await lstat(absolute)).isFile() || (await realpath(absolute)) !== absolute) {
      fail(`selected file is not a real entry file: ${file}`);
    }
    selected.push({ absolute, file });
  }
  return selected;
}

export function evaluateNodeTestEvents(
  events: Event[],
  contract: unknown,
  selectedFiles: Selected[],
  platform = process.platform,
): { protectedCount: number; observedCount: number; selectedFileCount: number } {
  const { required, exceptions } = validateNodeTestContract(contract);
  const selected = new Set(selectedFiles.map((item) => item.absolute));
  if (selected.size !== selectedFiles.length || selected.size === 0) {
    fail("invalid selected file evidence");
  }
  const evidence: Evidence = { selected, entries: new Map(), summaries: new Map() };
  for (const event of events) {
    collectEvent(event, evidence);
  }
  if (evidence.finalSummary === undefined || evidence.summaries.size !== selected.size) {
    fail("missing final or file summary");
  }
  const observed = observedEntries(evidence.entries);
  const protectedCount = countProtected(required, exceptions, selectedFiles, observed, platform);
  if (!evidence.finalSummary || [...evidence.summaries.values()].some((success) => !success)) {
    fail("test summary reports unsuccessful execution");
  }
  return { protectedCount, observedCount: observed.size, selectedFileCount: selected.size };
}

export function assertSupportedNodeTestRuntime(version = process.versions.node): void {
  const [major, minor, patch] = version.split(".").map(Number);
  const node24 = major === 24 && minor !== undefined && Number.isSafeInteger(minor) && minor >= 21;
  const node26 = major === 26 && minor !== undefined && Number.isSafeInteger(minor) && minor >= 0;
  if ((!node24 && !node26) || patch === undefined || !Number.isSafeInteger(patch) || patch < 0) {
    fail("requires Node >=24.21.0 <25 or >=26.0.0 <27");
  }
}

export async function runNodeTestExecution({
  root = process.cwd(),
  files,
  contractPath,
  runOptions = {},
  output = process.stdout,
}: {
  root?: string;
  files: string[];
  contractPath: string;
  runOptions?: NonNullable<Parameters<typeof run>[0]>;
  output?: NodeJS.WritableStream;
}): Promise<{ protectedCount: number; observedCount: number; selectedFileCount: number }> {
  assertSupportedNodeTestRuntime();
  // Canonicalize a root alias (for example macOS /var -> /private/var) before
  // checking entry files. Individual entry-file symlinks remain forbidden.
  const absoluteRoot = await realpath(resolve(root));
  const selected = await selectFiles(absoluteRoot, files);
  if (
    typeof contractPath !== "string" ||
    contractPath.length === 0 ||
    isAbsolute(contractPath) ||
    contractPath.includes("\\") ||
    contractPath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("contract path must be a normalized relative file");
  }
  const absoluteContract = resolve(absoluteRoot, contractPath);
  const contract = JSON.parse(await readContractFile(absoluteContract)) as unknown;
  const { required } = validateNodeTestContract(contract);
  if (!selected.some((file) => [...required.values()].some((item) => item.file === file.file))) {
    fail("selection contains no mandatory identities");
  }
  const events: Event[] = [];
  for await (const event of run({
    ...runOptions,
    cwd: absoluteRoot,
    files: selected.map((file) => file.absolute),
    concurrency: 1,
  })) {
    const observed = event as Event;
    events.push(observed);
    if (observed.type === "test:fail") {
      output.write(
        `FAIL ${boundedText(String(observed.data?.name), testNameLimit)}\n${nodeTestFailureDetail(observed.data)}\n`,
      );
    }
  }
  const result = evaluateNodeTestEvents(events, contract, selected);
  output.write(
    `Mandatory Node tests: ${result.protectedCount} required identities completed or exactly excepted\n`,
  );
  return result;
}
