import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

interface Inventory {
  readonly outcome: string;
  readonly packageContexts: readonly string[];
  readonly packages: readonly string[];
  readonly peerAssignments: readonly string[];
}

interface ReviewedDifferences {
  readonly reviewedContextDifferences: readonly {
    readonly context: string;
    readonly packageCoordinate: string;
    readonly reason: string;
  }[];
}

if (process.argv.length < 4 || process.argv.length > 5) {
  throw new Error(
    "Usage: compare-installed-inventories.mts <bun.json> <node.json> [reviewed-contexts.json]",
  );
}

const [bun, node] = await Promise.all(
  process.argv
    .slice(2, 4)
    .map(async (path) => JSON.parse(await readFile(resolve(path), "utf8")) as Inventory),
);
const reviewed =
  process.argv[4] === undefined
    ? { reviewedContextDifferences: [] }
    : (JSON.parse(await readFile(resolve(process.argv[4]), "utf8")) as ReviewedDifferences);
if (
  bun === undefined ||
  node === undefined ||
  bun.outcome !== "passed" ||
  node.outcome !== "passed"
) {
  throw new Error("Both installed inventories must have passed.");
}

function differences(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightSet = new Set(right);
  const leftSet = new Set(left);
  return [
    ...left.filter((value) => !rightSet.has(value)).map((value) => `bun-only ${value}`),
    ...right.filter((value) => !leftSet.has(value)).map((value) => `node-only ${value}`),
  ].toSorted();
}

const contextDifferences = differences(bun.packageContexts, node.packageContexts);
const reviewedContexts = new Map(
  reviewed.reviewedContextDifferences.map((entry) => [entry.context, entry]),
);
const unreviewedContexts = contextDifferences.filter((value) => {
  const identity = value.replace(/^(?:bun-only|node-only) /u, "");
  return !reviewedContexts.has(identity);
});
if (unreviewedContexts.length > 0) {
  throw new Error(
    `Unreviewed installed context differences: ${JSON.stringify(unreviewedContexts)}`,
  );
}
const packageDifferences = differences(bun.packages, node.packages);
const reviewedPackages = new Set(
  reviewed.reviewedContextDifferences.map((entry) => `bun-only ${entry.packageCoordinate}`),
);
const unreviewedPackages = packageDifferences.filter((value) => !reviewedPackages.has(value));
if (unreviewedPackages.length > 0) {
  throw new Error(`Unknown installed inventory differences: ${JSON.stringify(unreviewedPackages)}`);
}
for (const field of ["peerAssignments"] as const) {
  const unknown = differences(bun[field], node[field]);
  if (unknown.length > 0) {
    throw new Error(`Unknown installed inventory differences: ${JSON.stringify(unknown)}`);
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      outcome: "passed",
      reviewedContextDifference: contextDifferences.map((context) => ({
        context,
        ...(reviewedContexts.get(context.replace(/^(?:bun-only|node-only) /u, "")) ?? {
          packageCoordinate: "",
          reason: "",
        }),
      })),
      packageCoordinates: bun.packages.length,
      peerAssignments: bun.peerAssignments.length,
    },
    null,
    2,
  )}\n`,
);
