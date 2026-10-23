import {
  undici,
  formatsPeer,
  type Path,
  type Edges,
  type Importer,
  type Snapshot,
  type Lock,
  roots,
  claims,
  contexts,
  seeds,
  nodeTypes,
  formats,
  covered,
  need,
  isList,
  isObject,
  object,
  strings,
  names,
  locator,
  edge,
  edges,
  managedStarts,
  reach,
  same,
  kind,
} from "./restoration-lock-graph-values.js";
import {
  type JsonObject,
  type JsonValue,
  type ParsedRestorationLockInputs,
} from "../../application/model/restoration-lock-inputs.js";
import { type ManagedRestorationLockV1Diagnostic } from "../../application-api.js";
import { admitsCoveredArchiveRange } from "./restoration-lock-covered-ranges.js";
export function compare(
  expected: JsonValue | undefined,
  actual: JsonValue | undefined,
  path: Path,
  diagnostics: ManagedRestorationLockV1Diagnostic[],
  code: "mismatch" | "preservation",
): void {
  if (isObject(expected) && isObject(actual)) {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].toSorted()) {
      compare(expected[key], actual[key], [...path, key], diagnostics, code);
    }
  } else if (isList(expected) && isList(actual)) {
    for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
      compare(expected[index], actual[index], [...path, index], diagnostics, code);
    }
  } else if (!Object.is(expected, actual)) {
    diagnostics.push({
      code,
      path,
      message: `expected ${kind(expected)} differs from actual ${kind(actual)}`,
    });
  }
}

function validateCoveredDeclarationRanges(
  snapshot: Snapshot,
  resolved: Edges,
  declared: { readonly required: Edges; readonly optional: Edges; readonly peers: Edges },
): void {
  const { required, optional, peers } = declared;
  for (const [name, range] of [
    ...Object.entries(required),
    ...Object.entries(optional),
    ...Object.entries(peers),
  ]) {
    const version = resolved[name];
    if (version === undefined) {
      continue;
    }
    need(
      admitsCoveredArchiveRange(range, locator(edge(name, version)).version, need),
      "authenticated range does not admit edge",
    );
    if (Object.hasOwn(required, name) && !Object.hasOwn(peers, name)) {
      need(snapshot.dependencies?.[name] === version, "required declaration became optional");
    }
    if (Object.hasOwn(optional, name)) {
      need(
        snapshot.optionalDependencies?.[name] === version,
        "optional declaration became required",
      );
    }
  }
}

function validateCoveredManifestDeclarations(
  coordinate: string,
  manifest: JsonObject,
  original: Lock,
  source: Lock,
): { optionalNode: string[]; overlaps: string[] } {
  const optionalNode: string[] = [],
    overlaps: string[] = [];
  const tree = coordinate === nodeTypes || coordinate === undici ? source : original;
  const ids = Object.keys(tree.snapshots).filter((id) => locator(id).coordinate === coordinate);
  need(
    ids.length === 1 && ids[0] !== undefined && ids[0].length > 0,
    "covered coordinate has ambiguous snapshots",
  );
  const snapshot = tree.snapshots[ids[0]],
    pkg = tree.packages[coordinate];
  need(snapshot && pkg, "covered graph entry");
  const required = strings(manifest.dependencies ?? {});
  const optional = strings(manifest.optionalDependencies ?? {}),
    peers = strings(manifest.peerDependencies ?? {});
  const metadata = object(manifest.peerDependenciesMeta ?? {});
  same(pkg.peerDependencies ?? {}, manifest.peerDependencies ?? {}, "authenticated package peers");
  same(pkg.peerDependenciesMeta ?? {}, metadata, "authenticated package peer metadata");
  const resolved = Object.fromEntries(edges(snapshot)),
    expected = new Set([...Object.keys(required), ...Object.keys(optional)]);
  for (const [name, range] of Object.entries(peers)) {
    need(object(metadata[name]).optional === true, "unsupported covered nonoptional peer");
    if (name === "@types/node") {
      need(
        range === "*" && resolved[name] === undefined && tree === original,
        "original optional node peer",
      );
      optionalNode.push(ids[0]);
    } else {
      need(resolved[name] !== undefined, "missing covered peer");
      expected.add(name);
    }
    if (Object.hasOwn(required, name)) {
      overlaps.push(`${coordinate}/${name}`);
    }
  }
  names(Object.keys(resolved), [...expected], "covered archive/graph edge agreement");
  validateCoveredDeclarationRanges(snapshot, resolved, { required, optional, peers });
  return { optionalNode, overlaps };
}

export function declarations(
  inputs: ParsedRestorationLockInputs,
  original: Lock,
  source: Lock,
): string[] {
  names(Object.keys(inputs.archives), covered, "exact twelve covered archives");
  const optionalNode: string[] = [],
    overlaps: string[] = [];
  for (const coordinate of covered) {
    const archive = inputs.archives[coordinate];
    need(archive, "covered archive");
    const validated = validateCoveredManifestDeclarations(
      coordinate,
      archive.manifest,
      original,
      source,
    );
    optionalNode.push(...validated.optionalNode);
    overlaps.push(...validated.overlaps);
  }
  names(optionalNode, seeds, "exact three optional-node-peer seeds");
  names(overlaps, [formats + "/ajv"], "exact covered dependency/optional-peer overlap");
  const formatManifest = inputs.archives[formats]?.manifest;
  need(formatManifest, "formats manifest");
  need(
    strings(formatManifest.dependencies).ajv === "^8.0.0" &&
      strings(formatManifest.peerDependencies).ajv === "^8.0.0",
    "formats exact authenticated ranges",
  );
  const parents = Object.entries(original.snapshots).filter(
    ([, row]) => row.dependencies?.["ajv-formats"] !== undefined,
  );
  names(
    parents.map(([id]) => id),
    ["@agent-teams/docs-protocol@0.6.0", contexts[0] ?? "", seeds[0] ?? ""],
    "exact three formats parents",
  );
  for (const [, row] of parents) {
    need(
      row.dependencies?.["ajv-formats"] === "3.0.1(ajv@8.20.0)" &&
        row.dependencies.ajv === "8.20.0",
      "formats parent AJV identity",
    );
  }
  need(
    original.snapshots["@microsoft/tsdoc-config@0.18.2"]?.dependencies?.ajv === "8.18.0",
    "original tsdoc AJV",
  );
  names(
    Object.keys(original.packages).filter((id) => locator(id).name === "ajv"),
    ["ajv@8.18.0", "ajv@8.20.0"],
    "two original AJVs",
  );
  return optionalNode;
}
function supportedBoundary(row: JsonObject, packageEntry: boolean, formatEntry: boolean): void {
  const unsupported = packageEntry
    ? [
        "dependencies",
        "optionalDependencies",
        "dependenciesMeta",
        "patchedDependencies",
        "patched",
        "id",
      ]
    : [
        "devDependencies",
        "dependenciesMeta",
        "patchedDependencies",
        "patched",
        "injected",
        "id",
        "resolution",
        "name",
        "version",
      ];
  if (!packageEntry && !formatEntry) {
    unsupported.push("peerDependencies", "peerDependenciesMeta");
  }
  need(!unsupported.some((key) => Object.hasOwn(row, key)), "unsupported transformed graph field");
}
function rewritten(row: Snapshot, rename: ReadonlyMap<string, string>): Snapshot {
  const result: Record<string, JsonValue> = { ...row };
  for (const section of ["dependencies", "optionalDependencies"]) {
    if (!Object.hasOwn(row, section)) {
      continue;
    }
    result[section] = Object.fromEntries(
      Object.entries(strings(row[section])).map(([name, version]) => {
        const replacement = rename.get(edge(name, version));
        return [name, replacement === undefined ? version : replacement.slice(name.length + 1)];
      }),
    );
  }
  return result;
}

export function validatedOriginalManagedImporter(
  envelope: JsonObject,
  original: Lock,
  originalAll: ReadonlySet<string>,
): Importer {
  need(
    envelope.packageCount === 83 &&
      originalAll.size === 83 &&
      Object.keys(original.packages).length === 83,
    "rooted original83",
  );
  names(Object.keys(original.importers), ["."], "original root importer");
  const rootImporter = original.importers["."];
  need(rootImporter, "original importer");
  names(
    Object.keys(rootImporter.devDependencies ?? {}),
    Object.keys(roots),
    "exact original three roots",
  );
  for (const [name, version] of Object.entries(roots)) {
    const binding = rootImporter.devDependencies?.[name];
    need(binding?.version === version && binding.specifier === version, "original root coordinate");
  }
  need(isList(envelope.coordinates), "original claims");
  names(
    envelope.coordinates.map((value) => {
      const row = object(value);
      need(typeof row.name === "string" && typeof row.version === "string", "claim identity");
      need(row.role === (Object.hasOwn(roots, row.name) ? "direct" : "transitive"), "claim role");
      return `${row.name}@${row.version}`;
    }),
    claims,
    "exact five original claims",
  );
  need(isList(envelope.managedEdges), "managed edges");
  names(
    envelope.managedEdges.map((value) => {
      const row = object(value);
      need(typeof row.from === "string" && typeof row.to === "string", "managed edge identity");
      return `${row.from}->${row.to}`;
    }),
    [
      "@agent-teams/docs-protocol->@agent-teams/document-authoring",
      "@agent-teams/docs-protocol->@agent-teams/repository-mutation",
      "@agent-teams/docs-protocol-agent-teams->@agent-teams/docs-protocol",
      "@agent-teams/docs-protocol-agent-teams->@agent-teams/repository-mutation",
      "@agent-teams/document-authoring->@agent-teams/repository-mutation",
      "@agent-teams/engineering-foundation->@agent-teams/document-authoring",
      "@agent-teams/engineering-foundation->@agent-teams/repository-mutation",
    ],
    "original managed edge envelope",
  );
  names(
    [...reach(original, managedStarts(original))],
    [...originalAll],
    "original managed closure",
  );
  return rootImporter;
}

export function reverseNodePeerAncestors(
  original: Lock,
  originalAll: ReadonlySet<string>,
  selectedSeeds: readonly string[],
): Set<string> {
  const affected = new Set(selectedSeeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of originalAll) {
      const row = original.snapshots[id];
      need(row, "reverse graph entry");
      if (
        !affected.has(id) &&
        edges(row).some(([name, version]) => affected.has(edge(name, version)))
      ) {
        affected.add(id);
        changed = true;
      }
    }
  }
  names([...affected], contexts, "exact seven reverse dependency ancestors");
  return affected;
}

export function transformedManagedEntries(
  original: Lock,
  source: Lock,
  rename: ReadonlyMap<string, string>,
  selectedSeeds: readonly string[],
): { packages: Record<string, JsonValue>; transformed: Record<string, JsonValue> } {
  const packages: Record<string, JsonValue> = { ...original.packages },
    transformed: Record<string, JsonValue> = {};
  for (const [id, row] of Object.entries(original.snapshots)) {
    const pkg = original.packages[locator(id).coordinate];
    need(pkg, "transform package");
    if (rename.has(id)) {
      supportedBoundary(row, false, id === formatsPeer);
      supportedBoundary(pkg, true, id === formatsPeer);
    }
    const result: Record<string, JsonValue> = { ...rewritten(row, rename) };
    if (selectedSeeds.includes(id)) {
      result.optionalDependencies = {
        ...object(result.optionalDependencies ?? {}),
        "@types/node": "24.13.3",
      };
    }
    if (id === formatsPeer) {
      same(result.optionalDependencies, { ajv: "8.20.0" }, "formats original optional AJV");
      need(!Object.hasOwn(result, "dependencies"), "formats original required section");
      for (const field of ["peerDependencies", "peerDependenciesMeta"]) {
        if (Object.hasOwn(result, field)) {
          same(result[field], pkg[field], "formats snapshot peer metadata");
        }
        delete result[field];
      }
      delete result.optionalDependencies;
      result.dependencies = { ajv: "8.20.0" };
      const corrected: Record<string, JsonValue> = { ...pkg };
      delete corrected.peerDependencies;
      delete corrected.peerDependenciesMeta;
      packages[formats] = corrected;
    }
    transformed[rename.get(id) ?? id] = result;
  }
  same(packages[formats], source.packages[formats], "formats Source package agreement");
  same(transformed[formats], source.snapshots[formats], "formats Source snapshot agreement");
  for (const coordinate of [nodeTypes, undici]) {
    const pkg = source.packages[coordinate],
      row = source.snapshots[coordinate];
    need(pkg && row, "borrowed Source entries");
    names(
      edges(row).map(([name, version]) => edge(name, version)),
      coordinate === nodeTypes ? [undici] : [],
      "exact borrowed reachability",
    );
    if (coordinate === nodeTypes) {
      need(row.dependencies?.["undici-types"] === "7.18.2", "required node-to-undici edge");
    }
    packages[coordinate] = pkg;
    transformed[coordinate] = row;
  }
  return { packages, transformed };
}
