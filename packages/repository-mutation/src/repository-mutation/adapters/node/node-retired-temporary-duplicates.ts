import type { RetiredTemporaryInspectionBudget } from "../../application/ports/retired-temporary-inspection-budget.js";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BoundedRegularFileRead } from "../../../path-identity.js";
import type { KnownFileCoordination } from "./known-file-coordination.js";
import { assertSafeExistingRepositoryAncestors } from "./node-existing-repository-ancestors.js";
import { OWNED_TEMPORARY_RETIRED_EVIDENCE_MARKER } from "./node-cleanup-owned-temporary.js";

type Observation = Pick<KnownFileCoordination, "readBoundedRegularFile">;
type StableRead = Extract<BoundedRegularFileRead, { readonly outcome: "read" }>;

function budgetedObservation(
  observation: Observation,
  budget: RetiredTemporaryInspectionBudget | undefined,
): Observation {
  return {
    async readBoundedRegularFile(path, maximumBytes) {
      budget?.checkpoint();
      const grant = budget?.beforeRead(maximumBytes) ?? maximumBytes;
      if (!Number.isSafeInteger(grant) || grant < 0 || grant > maximumBytes) {
        throw new TypeError("Retirement observation budget cannot widen the owner read bound.");
      }
      let charged = grant;
      try {
        const result = await observation.readBoundedRegularFile(path, grant);
        if (result.outcome === "read") {
          charged = result.bytes.byteLength;
        }
        return result;
      } finally {
        budget?.afterRead(charged);
        budget?.checkpoint();
      }
    },
  };
}

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
  checkpoint: () => void,
): Promise<readonly string[]> {
  const matches: string[] = [];
  for (const candidate of candidates) {
    checkpoint();
    await assertSafeExistingRepositoryAncestors(root, candidate);
    checkpoint();
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
  checkpoint: () => void,
): Promise<string | undefined> {
  checkpoint();
  await assertSafeExistingRepositoryAncestors(root, path);
  checkpoint();
  const evidencePath = resolve(root, path);
  const directory = dirname(evidencePath);
  const entries = await readdir(directory);
  checkpoint();
  if (entries.length !== 1 || entries[0] !== "owned-temporary") {
    return undefined;
  }
  const before = await lstat(directory, { bigint: true });
  checkpoint();
  const evidence = await observation.readBoundedRegularFile(evidencePath, 2 * 1024 * 1024);
  if (evidence.outcome !== "read" || evidence.linkCount !== 2n) {
    return undefined;
  }
  const matches = await counterpartMatches(observation, root, candidates, evidence, checkpoint);
  const after = await observation.readBoundedRegularFile(evidencePath, 2 * 1024 * 1024);
  checkpoint();
  const directoryAfter = await lstat(directory, { bigint: true });
  checkpoint();
  if (
    matches.length !== 1 ||
    !sameOwnedRead(after, evidence) ||
    before.dev !== directoryAfter.dev ||
    before.ino !== directoryAfter.ino ||
    before.birthtimeNs !== directoryAfter.birthtimeNs ||
    before.mtimeNs !== directoryAfter.mtimeNs
  ) {
    return undefined;
  }
  const entriesAfter = await readdir(directory);
  checkpoint();
  return entriesAfter.join("\0") === "owned-temporary" ? matches[0] : undefined;
}

/** Read-only duplicate observation, never deletion or transaction recovery authority. */
export async function inspectRetiredTemporaryDuplicates(
  observation: Observation,
  consumerRoot: string,
  filePaths: readonly string[],
  budget?: RetiredTemporaryInspectionBudget,
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
  budget?.checkpoint();
  const bounded = budgetedObservation(observation, budget);
  const root = await realpath(consumerRoot);
  budget?.checkpoint();
  const observed: { path: string; counterpart: string }[] = [];
  const siblings = new Map<string, string[]>();
  for (const candidate of filePaths) {
    budget?.checkpoint();
    if (!/\.(?:[cm]?tsx?|mjs|md)$/u.test(candidate)) {
      continue;
    }
    const parent = dirname(candidate);
    const entries = siblings.get(parent) ?? [];
    entries.push(candidate);
    siblings.set(parent, entries);
  }
  for (const path of filePaths) {
    budget?.checkpoint();
    const parent = retirementParent(path);
    if (parent === undefined) {
      continue;
    }
    const counterpart = await inspectDuplicate(
      bounded,
      root,
      path,
      siblings.get(parent) ?? [],
      () => budget?.checkpoint(),
    );
    if (counterpart !== undefined) {
      observed.push({ path, counterpart });
    }
  }
  budget?.checkpoint();
  return observed;
}
