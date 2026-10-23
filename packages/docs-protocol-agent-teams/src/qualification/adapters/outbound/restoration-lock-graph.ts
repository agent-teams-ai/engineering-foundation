import {
  undici,
  formatsPeer,
  type Path,
  sections,
  roots,
  claims,
  nodeTypes,
  suffix,
  formats,
  covered,
  Refusal,
  need,
  object,
  names,
  exact,
  locator,
  edge,
  lock,
  starts,
  managedStarts,
  reach,
  rooted,
  canonical,
  same,
} from "./restoration-lock-graph-values.js";
import { createHash } from "node:crypto";
import {
  type JsonValue,
  type ParsedRestorationLockInputs,
} from "../../application/model/restoration-lock-inputs.js";
import {
  type ManagedRestorationLockV1Diagnostic,
  type ManagedRestorationLockV1Result,
  type ManagedRestorationLockV1Provenance,
} from "../../application-api.js";
import { collectRestorationLockAnnotations } from "./restoration-lock-annotations.js";
import { admitRestorationLockInputs } from "./restoration-lock-inputs.js";
import {
  compare,
  declarations,
  validatedOriginalManagedImporter,
  reverseNodePeerAncestors,
  transformedManagedEntries,
} from "./restoration-lock-graph-transform.js";
function derive(inputs: ParsedRestorationLockInputs) {
  const envelope = inputs.original.tree,
    original = lock(object(envelope.pnpmLock)),
    source = lock(inputs.source.tree);
  const originalAll = rooted(original),
    sourceAll = rooted(source);
  const rootImporter = validatedOriginalManagedImporter(envelope, original, originalAll);
  const selectedSeeds = declarations(inputs, original, source);
  const affected = reverseNodePeerAncestors(original, originalAll, selectedSeeds);
  const rename = new Map(
    [...affected].map((id) => {
      need(locator(id).context === "", "preexisting node context");
      return [id, id + suffix];
    }),
  );
  rename.set(formatsPeer, formats);
  names([...new Set(rename.values())], [...rename.values()], "injective locator substitution");
  for (const destination of rename.values()) {
    need(!Object.hasOwn(original.snapshots, destination), "locator collision");
  }
  const { packages, transformed } = transformedManagedEntries(
    original,
    source,
    rename,
    selectedSeeds,
  );
  const sourceManaged = reach(source, managedStarts(source)),
    foreign = reach(source, starts(source, true));
  need(sourceManaged.size === 85 && sourceAll.size === 127, "Source closure counts");
  const removed = [...sourceManaged].filter(
    (id) => !Object.hasOwn(transformed, id) && !foreign.has(id),
  );
  const removedCoordinates = [...new Set(removed.map((id) => locator(id).coordinate))];
  need(removed.length === 5 && removedCoordinates.length === 5, "five superseded Source entries");
  names(
    removedCoordinates.map((id) => locator(id).name),
    claims.map((id) => locator(id).name),
    "superseded managed identities",
  );
  const expectedSnapshots: Record<string, JsonValue> = { ...source.snapshots };
  for (const id of removed) {
    delete expectedSnapshots[id];
  }
  Object.assign(expectedSnapshots, transformed);
  const used = new Set(Object.keys(expectedSnapshots).map((id) => locator(id).coordinate));
  const expectedPackages: Record<string, JsonValue> = { ...source.packages };
  const deletedPackages = Object.keys(expectedPackages).filter((id) => !used.has(id));
  names(deletedPackages, removedCoordinates, "derived Source package deletion");
  for (const id of deletedPackages) {
    delete expectedPackages[id];
  }
  Object.assign(expectedPackages, packages);
  const foreignPackages = new Set([...foreign].map((id) => locator(id).coordinate));
  for (const id of foreign) {
    same(expectedSnapshots[id], source.snapshots[id], "shared/foreign snapshot preservation");
  }
  for (const id of foreignPackages) {
    same(expectedPackages[id], source.packages[id], "shared/foreign package preservation");
  }
  const sourceRoot = source.importers["."];
  need(sourceRoot, "Source root");
  const devDependencies: Record<string, JsonValue> = { ...sourceRoot.devDependencies };
  for (const name of Object.keys(roots)) {
    const binding = rootImporter.devDependencies?.[name];
    need(binding, "original root binding");
    const replacement = rename.get(edge(name, binding.version));
    devDependencies[name] = {
      ...binding,
      version: replacement === undefined ? binding.version : replacement.slice(name.length + 1),
    };
  }
  const expected = lock({
    ...source,
    packages: expectedPackages,
    snapshots: expectedSnapshots,
    importers: { ...source.importers, ".": { ...sourceRoot, devDependencies } },
  });
  const whole = rooted(expected),
    managed = reach(expected, managedStarts(expected));
  names([...managed], Object.keys(transformed), "exact transformed managed reachability");
  const foreignOnly = [...whole].filter((id) => !managed.has(id));
  need(
    managed.size === 85 && foreignOnly.length === 42 && whole.size === 127,
    "85 managed plus 42 foreign equals 127",
  );
  const commentRename = new Map<string, string>();
  for (const id of removed) {
    const originalCoordinate = claims.find(
      (candidate) => locator(candidate).name === locator(id).name,
    );
    need(
      originalCoordinate !== undefined && originalCoordinate.length > 0,
      "superseded comment owner",
    );
    commentRename.set("packages/" + locator(id).coordinate, originalCoordinate);
    commentRename.set("snapshots/" + id, rename.get(originalCoordinate) ?? originalCoordinate);
  }
  return {
    expected,
    originalCount: originalAll.size,
    managedCount: managed.size,
    foreignCount: foreignOnly.length,
    wholeCount: whole.size,
    contextLocators: [...affected].map((id) => id + suffix).toSorted(),
    removedCoordinates: removedCoordinates.toSorted(),
    foreign,
    foreignPackages,
    commentRename,
  };
}

function protectedForeign(
  path: Path,
  foreign: ReadonlySet<string>,
  packages: ReadonlySet<string>,
): boolean {
  const [section, id, group, name] = path;
  if (section === undefined) {
    return false;
  }
  if (section === "packages") {
    return typeof id === "string" && packages.has(id);
  }
  if (section === "snapshots") {
    return typeof id === "string" && foreign.has(id);
  }
  if (section !== "importers") {
    return true;
  }
  if (id === undefined) {
    return false;
  }
  if (id !== ".") {
    return true;
  }
  if (typeof group !== "string") {
    return false;
  }
  if (!sections.some((sectionName) => sectionName === group)) {
    return true;
  }
  return typeof name === "string" && !Object.hasOwn(roots, name);
}

/** Fixed managed-qualification helper. Actual bytes are never an expected-graph input. */
export function evaluateManagedRestorationLockV1(request: unknown): ManagedRestorationLockV1Result {
  let phase: "input" | "derivation" = "input";
  try {
    exact(request, [
      "schemaVersion",
      "selection",
      "originalClosureBytes",
      "sourceLockBytes",
      "actualLockBytes",
      "archiveBytes",
    ]);
    need(request.schemaVersion === 1, "request version");
    const selection = request.selection;
    exact(selection, ["originalClosureSha256", "sourceLockSha256", "sourceLockBlob", "archives"]);
    const archivePins = selection.archives,
      archiveBytes = request.archiveBytes;
    exact(archivePins, covered);
    exact(archiveBytes, covered);
    const { originalClosureSha256, sourceLockSha256, sourceLockBlob } = selection;
    need(
      typeof originalClosureSha256 === "string" &&
        typeof sourceLockSha256 === "string" &&
        typeof sourceLockBlob === "string",
      "selection string",
    );
    const archives: Record<string, Uint8Array> = {};
    const pins = Object.fromEntries(
      covered.map((coordinate) => {
        const pin = archivePins[coordinate];
        exact(pin, ["sha256", "manifestSha256", "manifestPath"]);
        need(
          typeof pin.sha256 === "string" &&
            typeof pin.manifestSha256 === "string" &&
            typeof pin.manifestPath === "string",
          "archive pin strings",
        );
        const bytes = archiveBytes[coordinate];
        need(bytes instanceof Uint8Array, "archive bytes");
        archives[coordinate] = bytes;
        return [
          coordinate,
          Object.freeze({
            sha256: pin.sha256,
            manifestSha256: pin.manifestSha256,
            manifestPath: pin.manifestPath,
          }),
        ] as const;
      }),
    );
    const original = request.originalClosureBytes,
      source = request.sourceLockBytes;
    need(original instanceof Uint8Array && source instanceof Uint8Array, "graph bytes");
    const actualBytes = request.actualLockBytes;
    need(
      actualBytes instanceof Uint8Array && actualBytes.byteLength <= 4 * 1024 * 1024,
      "actual byte bound",
    );
    const actual = Buffer.from(actualBytes);
    const bindings = {
      originalClosureSha256,
      sourceLockSha256,
      sourceLockBlob,
      actualLockSha256: createHash("sha256").update(actual).digest("hex"),
      archives: pins,
    };
    const inputs = admitRestorationLockInputs({ original, source, actual, archives }, bindings);
    phase = "derivation";
    const derived = derive(inputs);
    const diagnostics: ManagedRestorationLockV1Diagnostic[] = [];
    compare(derived.expected, inputs.actual.tree, [], diagnostics, "mismatch");
    const protect = (path: Path) =>
      protectedForeign(path, derived.foreign, derived.foreignPackages);
    const { source: sourceAnnotations, actual: actualAnnotations } =
      collectRestorationLockAnnotations(
        inputs.source.bytes,
        inputs.actual.bytes,
        protect,
        derived.commentRename,
        need,
      );
    compare(
      sourceAnnotations.comments,
      actualAnnotations.comments,
      ["$yaml", "comments"],
      diagnostics,
      "preservation",
    );
    compare(
      sourceAnnotations.spelling,
      actualAnnotations.spelling,
      ["$yaml", "foreign"],
      diagnostics,
      "preservation",
    );
    const expectedLockDigest: `sha256:${string}` = `sha256:${createHash("sha256")
      .update("managed-restoration-lock/v1\n")
      .update(canonical(derived.expected))
      .digest("hex")}`;
    const provenance: ManagedRestorationLockV1Provenance = {
      originalClosureSha256: bindings.originalClosureSha256,
      originalPackageManager: "pnpm@11.20.0",
      sourceLockSha256: bindings.sourceLockSha256,
      sourceLockBlob: bindings.sourceLockBlob,
      archives: Object.freeze(pins),
      originalSnapshotCount: derived.originalCount,
      managedSnapshotCount: derived.managedCount,
      foreignOnlySnapshotCount: derived.foreignCount,
      wholeSnapshotCount: derived.wholeCount,
      contextLocators: Object.freeze(derived.contextLocators),
      borrowedCoordinates: Object.freeze([nodeTypes, undici]),
      removedSourceCoordinates: Object.freeze(derived.removedCoordinates),
    };
    return diagnostics.length === 0
      ? {
          schemaVersion: 1,
          conformance: "conformant",
          expectedLockDigest,
          provenance,
          diagnostics: [],
        }
      : {
          schemaVersion: 1,
          conformance: "nonconformant",
          expectedLockDigest,
          provenance,
          diagnostics,
        };
  } catch (cause: unknown) {
    return {
      schemaVersion: 1,
      conformance: "nonconformant",
      diagnostics: [
        {
          code: phase,
          path: cause instanceof Refusal ? cause.path : [],
          message: cause instanceof Error ? cause.message : "input rejected",
        },
      ],
    };
  }
}
