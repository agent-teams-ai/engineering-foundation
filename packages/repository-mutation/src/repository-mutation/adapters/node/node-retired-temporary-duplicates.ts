import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BoundedRegularFileRead } from "../../../path-identity.js";
import type { KnownFileCoordination } from "./known-file-coordination.js";
import { assertSafeExistingRepositoryAncestors } from "./node-existing-repository-ancestors.js";
import { OWNED_TEMPORARY_RETIRED_EVIDENCE_MARKER } from "./node-cleanup-owned-temporary.js";

type Observation = Pick<KnownFileCoordination, "readBoundedRegularFile">;
type StableRead = Extract<BoundedRegularFileRead, { readonly outcome: "read" }>;

function sameOwnedRead(left: BoundedRegularFileRead, right: StableRead): boolean {
  return (
    left.outcome === "read" &&
    left.linkCount === 2n &&
    left.identity.dev === right.identity.dev &&
    left.identity.ino === right.identity.ino &&
    left.identity.birthtimeNs === right.identity.birthtimeNs &&
    left.bytes.equals(right.bytes)
  );
}

function retirementParent(path: string): string | undefined {
  const segments = path.split("/");
  const index = segments.indexOf(OWNED_TEMPORARY_RETIRED_EVIDENCE_MARKER);
  if (index < 0 || segments.lastIndexOf(OWNED_TEMPORARY_RETIRED_EVIDENCE_MARKER) !== index) {
    return undefined;
  }
  const suffix = segments.slice(index + 1).join("/");
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/owned-temporary$/u.test(
      suffix,
    )
  ) {
    return undefined;
  }
  return segments.slice(0, index).join("/") || ".";
}

async function counterpartMatches(
  observation: Observation,
  root: string,
  candidates: readonly string[],
  evidence: StableRead,
): Promise<readonly string[]> {
  const matches: string[] = [];
  for (const candidate of candidates) {
    await assertSafeExistingRepositoryAncestors(root, candidate);
    const canonical = await observation.readBoundedRegularFile(
      join(root, candidate),
      2 * 1024 * 1024,
    );
    if (sameOwnedRead(canonical, evidence)) {
      matches.push(candidate);
    }
  }
  return matches;
}

async function inspectDuplicate(
  observation: Observation,
  root: string,
  path: string,
  candidates: readonly string[],
): Promise<string | undefined> {
  await assertSafeExistingRepositoryAncestors(root, path);
  const evidencePath = resolve(root, path);
  const directory = dirname(evidencePath);
  const entries = await readdir(directory);
  if (entries.length !== 1 || entries[0] !== "owned-temporary") {
    return undefined;
  }
  const before = await lstat(directory, { bigint: true });
  const evidence = await observation.readBoundedRegularFile(evidencePath, 2 * 1024 * 1024);
  if (evidence.outcome !== "read" || evidence.linkCount !== 2n) {
    return undefined;
  }
  const matches = await counterpartMatches(observation, root, candidates, evidence);
  const after = await observation.readBoundedRegularFile(evidencePath, 2 * 1024 * 1024);
  const directoryAfter = await lstat(directory, { bigint: true });
  if (
    matches.length !== 1 ||
    !sameOwnedRead(after, evidence) ||
    before.dev !== directoryAfter.dev ||
    before.ino !== directoryAfter.ino ||
    before.birthtimeNs !== directoryAfter.birthtimeNs ||
    before.mtimeNs !== directoryAfter.mtimeNs ||
    (await readdir(directory)).join("\0") !== "owned-temporary"
  ) {
    return undefined;
  }
  return matches[0];
}

/** Read-only duplicate observation, never deletion or transaction recovery authority. */
export async function inspectRetiredTemporaryDuplicates(
  observation: Observation,
  consumerRoot: string,
  filePaths: readonly string[],
): Promise<readonly { readonly path: string; readonly counterpart: string }[]> {
  if (
    filePaths.length > 500_000 ||
    filePaths.some(
      (path) =>
        path.startsWith("/") ||
        /[\\:]/u.test(path) ||
        path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
    )
  ) {
    throw new TypeError(
      "Retired evidence inspection requires a bounded contained repository census.",
    );
  }
  const root = await realpath(consumerRoot);
  const observed: { path: string; counterpart: string }[] = [];
  const siblings = new Map<string, string[]>();
  for (const candidate of filePaths) {
    if (!/\.(?:[cm]?tsx?|mjs|md)$/u.test(candidate)) {
      continue;
    }
    const parent = dirname(candidate);
    const entries = siblings.get(parent) ?? [];
    entries.push(candidate);
    siblings.set(parent, entries);
  }
  for (const path of filePaths) {
    const parent = retirementParent(path);
    if (parent === undefined) {
      continue;
    }
    const counterpart = await inspectDuplicate(observation, root, path, siblings.get(parent) ?? []);
    if (counterpart !== undefined) {
      observed.push({ path, counterpart });
    }
  }
  return observed;
}
