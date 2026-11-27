import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  digest,
  row,
  text,
  type Campaign,
  type HelperResult,
  type PreparedCase,
  type Row,
} from "./campaign-support.ts";

export const preparedRefusalCases = [
  "wrong-controller",
  "wrong-target-runtime",
  "wrong-manager",
  "stale-preparation-digest",
  "lock-digest",
  "lock-foreign-scope",
  "wrong-root",
  "build-drift",
  "pin-bytes",
  "pin-mode",
  "foreign-image",
] as const;
export type PreparedRefusal = (typeof preparedRefusalCases)[number];

interface ObservedFile {
  readonly path: string;
  readonly mode: number;
  readonly device: number;
  readonly inode: number;
  readonly bytes: number;
  readonly sha256: string;
}
interface CapturedFile {
  readonly content: Buffer;
  readonly image: ObservedFile;
}

export function readRegular(path: string): CapturedFile {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  assert(stat.size <= 32 * 1024 * 1024);
  assert.equal(realpathSync(path), path);
  const content = readFileSync(path);
  assert.equal(content.length, stat.size);
  return {
    content,
    image: {
      path,
      mode: stat.mode & 0o777,
      device: stat.dev,
      inode: stat.ino,
      bytes: content.length,
      sha256: digest(content),
    },
  };
}

export function freshDirectory(path: string): void {
  assert(!existsSync(path), `Refusal evidence or fixture already exists: ${path}`);
  mkdirSync(path, { recursive: false, mode: 0o700 });
  assert.equal(realpathSync(path), path);
}

export function retain(path: string, content: Buffer): void {
  writeFileSync(path, content, { flag: "wx", mode: 0o600 });
  assert.equal(readRegular(path).image.sha256, digest(content));
}

export function completionPath(prepared: PreparedCase): string {
  const completion = text(prepared.selection["completionPath"], "actual completion path");
  assert.equal(prepared.preparation.path, `${completion}.prepared`);
  return completion;
}

export function proofImages(prepared: PreparedCase, directory?: string, phase = ""): Row[] {
  const completion = completionPath(prepared);
  return [
    ["preparation", prepared.preparation.path],
    ["completion", completion],
    ["receipt", `${completion}.receipt`],
  ].map(([name, path]) => {
    assert(name !== undefined && path !== undefined);
    if (!existsSync(path)) {
      return { name, path, state: "absent" };
    }
    const captured = readRegular(path);
    if (name === "preparation") {
      assert.equal(captured.image.sha256, prepared.preparation.sha256);
    }
    if (directory !== undefined) {
      retain(join(directory, `${phase}-${name}.bin`), captured.content);
    }
    return { name, state: "file", ...captured.image };
  });
}

export function mismatchedDigest(actual: string): string {
  assert(/^sha256:[0-9a-f]{64}$/u.test(actual));
  const changed = `sha256:${actual[7] === "1" ? "2" : "1"}${actual.slice(8)}`;
  assert(changed !== actual && /^sha256:(?!0{64}$)[0-9a-f]{64}$/u.test(changed));
  return changed;
}

function assertRefusal(result: HelperResult, selected: PreparedRefusal): void {
  const value = result.result;
  assert.equal(value["evidenceClass"], "actual-published-controller-admission-refusal");
  assert.equal(value["refusalCase"], selected);
  assert.equal(value["trackedImagesUnchanged"], true);
  assert.equal(value["priorLocalEvidenceUnchanged"], true);
  assert.equal(value["proofsUnchanged"], true);
  assert.equal(value["publicBarrier"], "idle");
  const pid = value["spawnedChildPid"];
  assert(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0);
  assert.equal(row(value["envelope"], "actual public refusal envelope")["outcome"], "blocked");
  // Exact owner code/message, public exit and the four lease exceptions remain
  // enforced by the unchanged refusal collector, not duplicated here.
}

export interface RefusalCall {
  readonly directory: string;
  readonly fault: Row;
  readonly fields?: Row;
}
export async function runRefusal(
  campaign: Campaign,
  prepared: PreparedCase,
  selected: PreparedRefusal,
  options: RefusalCall,
): Promise<HelperResult> {
  const { directory, fault, fields = {} } = options;
  const before = proofImages(prepared, directory, "before");
  campaign.record(`${prepared.name}-${selected}-before`, { fault, fields, proofs: before });
  const result = await campaign.call(prepared, "refusal", selected, {
    ...fields,
    operation: "refusal",
    refusalCase: selected,
    fault,
  });
  assertRefusal(result, selected);
  const after = proofImages(prepared, directory, "after");
  assert.deepEqual(after, before);
  campaign.record(`${prepared.name}-${selected}-verified`, {
    output: result.output,
    result: result.result,
    originalProofsPreserved: true,
    proofs: after,
  });
  return result;
}

export interface FileFault extends RefusalCall {
  readonly path: string;
  readonly content: Buffer;
  readonly mode: number;
}
export async function fileFault(
  campaign: Campaign,
  prepared: PreparedCase,
  selected: "pin-bytes" | "pin-mode" | "foreign-image" | "build-drift",
  options: FileFault,
): Promise<HelperResult> {
  const { directory, path, content, mode, fault, fields = {} } = options;
  const before = readRegular(path);
  retain(join(directory, "original-file.bin"), before.content);
  retain(join(directory, "injected-file.bin"), content);
  const bytesChanged = !before.content.equals(content);
  const modeChanged = before.image.mode !== mode;
  assert(bytesChanged || modeChanged);
  campaign.record(`${prepared.name}-${selected}-fault-before`, { original: before.image });
  assert.deepEqual(readRegular(path).image, before.image);
  if (bytesChanged) {
    writeFileSync(path, content, { flag: "w" });
  }
  if (modeChanged) {
    chmodSync(path, mode);
  }
  const injected = readRegular(path);
  assert.equal(injected.image.device, before.image.device);
  assert.equal(injected.image.inode, before.image.inode);
  assert.equal(injected.image.sha256, digest(content));
  assert.equal(injected.image.mode, mode);
  campaign.record(`${prepared.name}-${selected}-fault-injected`, {
    original: before.image,
    injected: injected.image,
    originalBytes: campaign.selected(join(directory, "original-file.bin")),
    injectedBytes: campaign.selected(join(directory, "injected-file.bin")),
  });

  // On an exception, retain the exact fault and evidence for owner reconciliation.
  // Never erase a failure or reverse while process/transaction custody is unknown.
  const result = await runRefusal(campaign, prepared, selected, { directory, fault, fields });
  assert.deepEqual(readRegular(path).image, injected.image, "Fault changed during refusal");
  if (bytesChanged) {
    writeFileSync(path, before.content, { flag: "w" });
  }
  if (modeChanged) {
    chmodSync(path, before.image.mode);
  }
  const restored = readRegular(path).image;
  assert.deepEqual(restored, before.image);
  campaign.record(`${prepared.name}-${selected}-fault-restored`, {
    original: before.image,
    restored,
    onlyInjectedChangeReversed: true,
    helperOutput: result.output,
  });
  return result;
}
