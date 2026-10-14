import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

interface Inventory {
  readonly outcome: "passed";
  readonly packageContexts: number;
  readonly packages: readonly string[];
  readonly peerAssignments: readonly string[];
}

if (process.argv.length !== 4) {
  throw new Error("Usage: compare-installed-inventories.mts <bun.json> <node.json>");
}

const [bun, node] = await Promise.all(
  process.argv.slice(2).map(async (path) =>
    JSON.parse(await readFile(resolve(path), "utf8")) as Inventory
  )
);
if (bun.outcome !== "passed" || node.outcome !== "passed") {
  throw new Error("Both installed inventories must have passed.");
}

const differences: Record<string, readonly string[]> = {};
for (const field of ["packages", "peerAssignments"] as const) {
  const left = new Set(bun[field]);
  const right = new Set(node[field]);
  const onlyBun = [...left].filter((value) => !right.has(value)).toSorted();
  const onlyNode = [...right].filter((value) => !left.has(value)).toSorted();
  if (onlyBun.length > 0 || onlyNode.length > 0) {
    differences[field] = Object.freeze([
      ...onlyBun.map((value) => `bun-only ${value}`),
      ...onlyNode.map((value) => `node-only ${value}`)
    ]);
  }
}
if (Object.keys(differences).length > 0) {
  throw new Error(`Unknown installed inventory differences: ${JSON.stringify(differences)}`);
}

process.stdout.write(`${JSON.stringify({
  outcome: "passed",
  reviewedContextDifference: {
    bunPackageContexts: bun.packageContexts,
    nodePackageContexts: node.packageContexts
  },
  packageCoordinates: bun.packages.length,
  peerAssignments: bun.peerAssignments.length
}, null, 2)}\n`);
