import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  CapabilityInputError,
  assertNotCancelled,
} from "../../../../../../features/validation-reporting/api.js";
import { readContainedRegularFile } from "../../../../../../source-inventory/node.js";
import type { Sha256DigestPort } from "../../../../application/ports/sha256-digest.js";
import {
  compareGeneratedSdkSnapshots,
  generatedSdkSnapshot,
  type GeneratedSdkDrift,
  type GeneratedSdkLeaf,
  type GeneratedSdkSnapshot,
} from "../../../use-cases/compare-generated-sdk.js";

const MAX_ENTRIES = 4096;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 32;

function fail(message: string): never {
  throw new CapabilityInputError({
    code: "SDK_GENERATED_OUTPUT_INVALID",
    phase: "protobuf-sdk-generation-observation",
    message,
    retryable: false,
  });
}

function portableSegment(value: string): boolean {
  return (
    /^[A-Za-z0-9_.-]+$/u.test(value) &&
    value !== "." &&
    value !== ".." &&
    !value.endsWith(".") &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(value)
  );
}

async function directoryRoot(path: string): Promise<string> {
  if (!isAbsolute(path) || !(await lstat(path)).isDirectory()) {
    fail("Generated output root must be an absolute, non-symlink directory.");
  }
  return realpath(path);
}

function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

interface Observation {
  readonly root: string;
  readonly digest: Sha256DigestPort;
  readonly signal: AbortSignal | undefined;
  readonly files: GeneratedSdkLeaf[];
  readonly identities: Set<string>;
  entries: number;
  bytes: number;
}

async function observeFile(state: Observation, path: string): Promise<void> {
  const bytes = await readContainedRegularFile({
    root: state.root,
    candidate: resolve(state.root, path),
    maxBytes: Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - state.bytes),
  });
  state.bytes += bytes.length;
  state.files.push({ path, contentDigest: state.digest.digest(bytes) });
}

async function observeDirectory(state: Observation, path: string, depth: number): Promise<void> {
  assertNotCancelled(state.signal);
  if (depth > MAX_DEPTH) {
    fail("Generated output exceeds the supported directory depth.");
  }
  const directory = resolve(state.root, path);
  if (!(await lstat(directory)).isDirectory()) {
    fail("Generated output contains an unsafe directory.");
  }
  const handle = await opendir(directory);
  for await (const entry of handle) {
    assertNotCancelled(state.signal);
    if (++state.entries > MAX_ENTRIES || !portableSegment(entry.name)) {
      fail("Generated output exceeds the supported inventory or path profile.");
    }
    const member = path === "" ? entry.name : `${path}/${entry.name}`;
    const identity = member.toLowerCase();
    if (state.identities.has(identity)) {
      fail("Generated output contains a portable path collision.");
    }
    state.identities.add(identity);
    if (entry.isDirectory()) {
      await observeDirectory(state, member, depth + 1);
    } else if (entry.isFile()) {
      await observeFile(state, member);
    } else {
      fail("Generated output contains a symlink or special file.");
    }
  }
}

async function observe(
  root: string,
  digest: Sha256DigestPort,
  signal: AbortSignal | undefined,
): Promise<GeneratedSdkSnapshot> {
  const state: Observation = {
    root,
    digest,
    signal,
    files: [],
    identities: new Set(),
    entries: 0,
    bytes: 0,
  };
  await observeDirectory(state, "", 0);
  assertNotCancelled(signal);
  return generatedSdkSnapshot(state.files, digest);
}

/**
 * The qualification Host owns generation and isolated, generated-only roots.
 * This observer has no write or process authority. Repeated reads detect
 * ordinary input movement; they are not a hostile filesystem sandbox.
 */
export async function observeGeneratedSdkDrift(
  input: {
    readonly expectedRoot: string;
    readonly regeneratedRoot: string;
    readonly signal?: AbortSignal;
  },
  digest: Sha256DigestPort,
): Promise<GeneratedSdkDrift> {
  assertNotCancelled(input.signal);
  const expectedRoot = await directoryRoot(input.expectedRoot);
  const regeneratedRoot = await directoryRoot(input.regeneratedRoot);
  if (contains(expectedRoot, regeneratedRoot) || contains(regeneratedRoot, expectedRoot)) {
    fail("Expected and regenerated SDK output roots must not overlap.");
  }
  const expected = await observe(expectedRoot, digest, input.signal);
  if (expected.files.length === 0) {
    fail("The declared expected SDK output is empty.");
  }
  const observed = await observe(regeneratedRoot, digest, input.signal);
  if (
    (await observe(expectedRoot, digest, input.signal)).digest !== expected.digest ||
    (await observe(regeneratedRoot, digest, input.signal)).digest !== observed.digest
  ) {
    fail("Generated SDK output changed during the observation.");
  }
  return compareGeneratedSdkSnapshots(expected, observed);
}
