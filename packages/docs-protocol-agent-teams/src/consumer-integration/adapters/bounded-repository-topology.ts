import { opendir } from "node:fs/promises";
import { join } from "node:path";

const MAXIMUM_ENTRIES = 100_000;
const MAXIMUM_DEPTH = 64;
const SKIPPED_DIRECTORIES = new Set([".git", ".pnpm-store", "node_modules"]);

export interface ConsumerRepositoryTopology {
  readonly agents: readonly string[];
  readonly integrationProfiles: readonly string[];
  readonly lockfiles: readonly string[];
  readonly pnpmfiles: readonly string[];
}

function sorted(values: string[]): readonly string[] {
  return Object.freeze(values.toSorted());
}

function childDirectory(input: {
  readonly absolute: string;
  readonly depth: number;
  readonly entryName: string;
  readonly path: string;
}): { readonly absolute: string; readonly relative: string; readonly depth: number } | undefined {
  if (SKIPPED_DIRECTORIES.has(input.entryName)) {return undefined;}
  if (input.depth >= MAXIMUM_DEPTH) {
    throw new TypeError(`Repository topology exceeds ${MAXIMUM_DEPTH} directory levels.`);
  }
  return {
    absolute: join(input.absolute, input.entryName),
    relative: input.path,
    depth: input.depth + 1
  };
}

export async function scanConsumerRepositoryTopology(
  root: string
): Promise<ConsumerRepositoryTopology> {
  const agents: string[] = [];
  const integrationProfiles: string[] = [];
  const lockfiles: string[] = [];
  const pnpmfiles: string[] = [];
  const pending: { readonly absolute: string; readonly relative: string; readonly depth: number }[] = [
    { absolute: root, relative: "", depth: 0 }
  ];
  let observed = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const handle = await opendir(directory.absolute);
    for await (const entry of handle) {
      observed += 1;
      if (observed > MAXIMUM_ENTRIES) {
        throw new TypeError(`Repository topology exceeds ${MAXIMUM_ENTRIES} entries.`);
      }
      const path = directory.relative === "" ? entry.name : `${directory.relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {continue;}
      if (entry.isDirectory()) {
        const child = childDirectory({
          absolute: directory.absolute,
          depth: directory.depth,
          entryName: entry.name,
          path
        });
        if (child !== undefined) {pending.push(child);}
        continue;
      }
      if (!entry.isFile()) {continue;}
      if (entry.name === "AGENTS.md") {agents.push(path);}
      if (entry.name === "pnpm-lock.yaml") {lockfiles.push(path);}
      if (entry.name === ".pnpmfile.cjs") {pnpmfiles.push(path);}
      if (path === "architecture/foundation/docs-consumer-integration.json" ||
        path.endsWith("/architecture/foundation/docs-consumer-integration.json")) {
        integrationProfiles.push(path);
      }
    }
  }
  return Object.freeze({
    agents: sorted(agents),
    integrationProfiles: sorted(integrationProfiles),
    lockfiles: sorted(lockfiles),
    pnpmfiles: sorted(pnpmfiles)
  });
}
