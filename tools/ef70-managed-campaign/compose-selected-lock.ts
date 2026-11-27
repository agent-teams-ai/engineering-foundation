import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isNode, parseDocument, visit } from "yaml";

// Bounded construction of an external selected-lock candidate. It does not
// change a consumer, select authority, qualify a cohort, or replace the public
// controller's restoration-scope and qualified-lock acceptance checks.
type Row = Record<string, unknown>;
function isRow(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function row(value: unknown, label: string): Row {
  assert(isRow(value), label);
  return value;
}
function text(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0, label);
  return value;
}
function list(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), label);
  return value;
}
function digest(bytes: string | Buffer): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}
function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
const [, , sourceArgument, centralArgument, cohortId, outputArgument] = process.argv;
assert(
  process.argv.length === 6 && sourceArgument && centralArgument && cohortId && outputArgument,
  "Usage: node compose-selected-lock.ts SOURCE_ROOT CENTRAL_ROOT COHORT_ID NEW_OUTPUT_ROOT",
);
assert(isAbsolute(outputArgument), "Output root must be absolute");
const sourceRoot = await realpath(sourceArgument);
const centralRoot = await realpath(centralArgument);
assert.equal(
  await realpath(dirname(outputArgument)),
  dirname(outputArgument),
  "Output parents must be canonical",
);
for (const protectedRoot of [sourceRoot, centralRoot]) {
  assert(
    outputArgument !== protectedRoot && !outputArgument.startsWith(protectedRoot + "/"),
    "Selected lock output must be external to both repositories",
  );
}
const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
assert.equal(
  git(sourceRoot, "status", "--porcelain", "--untracked-files=no"),
  "",
  "Use a clean disposable authenticated consumer source",
);
assert.equal(
  git(centralRoot, "status", "--porcelain", "--untracked-files=no"),
  "",
  "Use committed Central registry bytes, not a proposed qualification append",
);
const sourceRevision = git(sourceRoot, "rev-parse", "HEAD");
const sourceTree = git(sourceRoot, "rev-parse", "HEAD^{tree}");
const centralRevision = git(centralRoot, "rev-parse", "HEAD");
const originalBytes = await readFile(join(sourceRoot, "pnpm-lock.yaml"));
const originalManifest = await readFile(join(sourceRoot, "package.json"));
const registryPath = join(centralRoot, "governance/docs-qualified-cohorts.json");
const registryBytes = await readFile(registryPath);
const registry: unknown = JSON.parse(registryBytes.toString("utf8"));
const schema: unknown = JSON.parse(
  await readFile(join(centralRoot, "governance/docs-qualified-cohorts.schema.json"), "utf8"),
);
const ownerModule: unknown = await import(
  pathToFileURL(join(centralRoot, "scripts/docs-cohort-policy.mjs")).href
);
const owner = row(ownerModule, "Missing Central policy module");
function ownerCall(name: string, ...args: unknown[]): unknown {
  const operation = owner[name];
  assert(typeof operation === "function", "Missing owner function: " + name);
  const result: unknown = Reflect.apply(operation, undefined, args);
  return result;
}
ownerCall("validateDocsQualifiedCohorts", registry, schema);
const registryObject = row(registry, "Invalid registry");
const records = list(registryObject["cohorts"], "Missing records").map((value) =>
  row(value, "Invalid record"),
);
const record = records.find((value) => value["cohort_id"] === cohortId);
assert(
  record !== undefined && record["cohort_generation"] === 3,
  "Select an actual generation-3 cohort",
);
assert.equal(row(record["policy_identity"], "Missing selected policy")["version"], "3.1.0");
const events = list(registryObject["events"], "Missing events").map((value) =>
  row(value, "Invalid event"),
);
const lastEvent = events.findLast((value) => value["cohort_id"] === cohortId);
assert(lastEvent !== undefined, "Selected cohort has no lifecycle");
assert.equal(
  ownerCall("isDocsCohortSelectableForRepository", record, lastEvent["state"], 1333298097),
  true,
  "Cohort is not selectable for EF",
);
assert.deepEqual(record["canary_repositories"], [
  { repository_id: 1333298097, repository: "agent-teams-ai/extension-foundation" },
]);
assert.deepEqual(record["upgrade_from"], ["docs-2026-10-03-stable31"]);
assert.deepEqual(record["rollback_to"], ["docs-2026-10-03-stable31"]);
const authority = row(record["runtime_closure"], "Missing closure authority");
const expectedDigest = text(authority["digest"], "Missing closure digest");
assert(/^sha256:(?!0{64}$)[0-9a-f]{64}$/u.test(expectedDigest), "Invalid closure digest");
const closureRelative =
  "governance/docs-runtime-closures/" + expectedDigest.replace(":", "-") + ".json";
assert.equal(authority["projection_path"], closureRelative);
const canonicalBytes = await readFile(join(centralRoot, closureRelative));
assert.equal(digest(canonicalBytes), expectedDigest, "Retained closure bytes are not authentic");
const canonicalEvidence = row(
  JSON.parse(canonicalBytes.toString("utf8")),
  "Invalid closure evidence",
);
const canonical = row(canonicalEvidence["pnpmLock"], "Missing canonical pnpm graph");
const document = parseDocument(originalBytes.toString("utf8"), { uniqueKeys: true });
assert.equal(document.errors.length, 0, "Source YAML must be unambiguous");
const sourceValue: unknown = document.toJS({ maxAliasCount: 0 });
const source = row(sourceValue, "Invalid source lock");
const sourceImporters = row(source["importers"], "Missing source importers");
const sourceSnapshots = row(source["snapshots"], "Missing source snapshots");
const sourcePackages = row(source["packages"], "Missing source packages");
const canonicalImporters = row(canonical["importers"], "Missing canonical importers");
assert.deepEqual(Object.keys(canonicalImporters), ["."]);
const canonicalRoots = row(
  row(canonicalImporters["."], "Missing root")["devDependencies"],
  "Missing exact canonical managed roots",
);
const managedNames = new Set(Object.keys(canonicalRoots));
assert.deepEqual([...managedNames].toSorted(), [
  "@agent-teams/docs-protocol",
  "@agent-teams/docs-protocol-agent-teams",
  "@agent-teams/engineering-foundation",
]);
const canonicalSnapshots = row(canonical["snapshots"], "Missing canonical snapshots");
const canonicalPackages = row(canonical["packages"], "Missing canonical packages");
const sections = ["dependencies", "devDependencies", "optionalDependencies"] as const;
function section(value: Row, key: string): Row {
  return value[key] === undefined ? {} : row(value[key], "Invalid dependency section: " + key);
}
function locator(name: string, version: string): string | undefined {
  if (Object.hasOwn(sourceSnapshots, version)) {
    return version;
  }
  if (version.startsWith("link:") || version.startsWith("workspace:")) {
    return undefined;
  }
  const key = name + "@" + version;
  assert(Object.hasOwn(sourceSnapshots, key), "Missing source snapshot: " + key);
  return key;
}
const managedStarts: string[] = [];
const foreignStarts: string[] = [];
for (const [path, importerValue] of Object.entries(sourceImporters)) {
  const importer = row(importerValue, "Invalid importer");
  for (const category of sections) {
    for (const [name, bindingValue] of Object.entries(section(importer, category))) {
      const binding = row(bindingValue, "Invalid importer dependency");
      const key = locator(name, text(binding["version"], "Missing dependency version"));
      if (key === undefined) {
        continue;
      }
      const isManaged = path === "." && category === "devDependencies" && managedNames.has(name);
      (isManaged ? managedStarts : foreignStarts).push(key);
    }
  }
}
function reachable(starts: readonly string[]): Set<string> {
  const found = new Set<string>();
  const pending = [...starts];
  while (pending.length > 0) {
    const key = pending.pop();
    assert(key !== undefined);
    if (found.has(key)) {
      continue;
    }
    assert(found.size < 8192, "Source graph exceeds the bounded construction scope");
    found.add(key);
    const snapshot = row(sourceSnapshots[key], "Missing source graph node");
    for (const category of ["dependencies", "optionalDependencies"]) {
      for (const [name, version] of Object.entries(section(snapshot, category))) {
        const next = locator(name, text(version, "Invalid snapshot dependency"));
        if (next !== undefined) {
          pending.push(next);
        }
      }
    }
  }
  return found;
}
const managed = reachable(managedStarts);
const foreign = reachable(foreignStarts);
const physical = (key: string): string => key.split("(", 1)[0] ?? key;
const ownedSnapshots = new Set([...managed].filter((key) => !foreign.has(key)));
const protectedPhysical = new Set(
  Object.keys(sourceSnapshots)
    .filter((key) => !ownedSnapshots.has(key))
    .map(physical),
);
const ownedPackages = new Set(
  [...managed].map(physical).filter((key) => !protectedPhysical.has(key)),
);
function checkCollisions(
  original: Row,
  incoming: Row,
  replaceable: Set<string>,
  label: string,
): void {
  for (const [key, value] of Object.entries(incoming)) {
    if (Object.hasOwn(original, key) && !replaceable.has(key)) {
      assert.deepEqual(value, original[key], label + " collision: " + key);
    }
  }
}
checkCollisions(sourceSnapshots, canonicalSnapshots, ownedSnapshots, "Protected snapshot");
checkCollisions(sourcePackages, canonicalPackages, ownedPackages, "Protected package");
function comments(): string[] {
  const result: string[] = [];
  for (const value of [document.commentBefore, document.comment]) {
    if (typeof value === "string") {
      result.push(value);
    }
  }
  visit(document, (_key, node) => {
    if (isNode(node)) {
      for (const value of [node.commentBefore, node.comment]) {
        if (typeof value === "string") {
          result.push(value);
        }
      }
    }
  });
  return result;
}
const originalComments = comments();
for (const key of ownedSnapshots) {
  document.deleteIn(["snapshots", key]);
}
for (const key of ownedPackages) {
  document.deleteIn(["packages", key]);
}
for (const [key, value] of Object.entries(canonicalSnapshots)) {
  document.setIn(["snapshots", key], value);
}
for (const [key, value] of Object.entries(canonicalPackages)) {
  document.setIn(["packages", key], value);
}
for (const [name, binding] of Object.entries(canonicalRoots)) {
  document.setIn(["importers", ".", "devDependencies", name], binding);
}
const selectedBytes = Buffer.from(document.toString());
assert(
  selectedBytes.length > 0 && selectedBytes.length <= 32 * 1024 * 1024,
  "Selected lock must fit the public controller's bounded file size",
);
const selected = row(document.toJS({ maxAliasCount: 0 }), "Invalid composed lock");
function unownedImporters(lock: Row): Row {
  const importers = structuredClone(row(lock["importers"], "Missing importers"));
  const root = row(importers["."], "Missing root importer");
  const dependencies = row(root["devDependencies"], "Missing development roots");
  for (const name of managedNames) {
    delete dependencies[name];
  }
  return importers;
}
assert.deepEqual(unownedImporters(selected), unownedImporters(source), "Foreign importers changed");
const sourceSettings = structuredClone(source);
const selectedSettings = structuredClone(selected);
for (const key of ["importers", "packages", "snapshots"]) {
  delete sourceSettings[key];
  delete selectedSettings[key];
}
assert.deepEqual(selectedSettings, sourceSettings, "Lock settings or policies changed");
for (const [key, value] of Object.entries(sourceSnapshots)) {
  if (!ownedSnapshots.has(key)) {
    assert.deepEqual(
      row(selected["snapshots"], "Missing target snapshots")[key],
      value,
      "Foreign snapshot changed: " + key,
    );
  }
}
for (const [key, value] of Object.entries(sourcePackages)) {
  if (!ownedPackages.has(key)) {
    assert.deepEqual(
      row(selected["packages"], "Missing target packages")[key],
      value,
      "Foreign package changed: " + key,
    );
  }
}
assert.deepEqual(comments(), originalComments, "Source comments changed");
const observed = row(
  ownerCall("docsRuntimeClosureV2Evidence", selected, record["packages"]),
  "Owner closure validator did not return evidence",
);
assert.equal(observed["source"], canonicalBytes.toString("utf8"), "Managed closure bytes differ");
assert.equal(row(observed["authority"], "Missing observed authority")["digest"], expectedDigest);
const stagingManifest = row(
  JSON.parse(originalManifest.toString("utf8")),
  "Invalid source manifest",
);
stagingManifest["packageManager"] = "pnpm@11.20.0";
const stagingDependencies = row(stagingManifest["devDependencies"], "Missing source managed roots");
for (const [name, value] of Object.entries(canonicalRoots)) {
  stagingDependencies[name] = text(
    row(value, "Invalid canonical root")["specifier"],
    "Missing exact root",
  );
}
assert(
  (await readFile(join(sourceRoot, "pnpm-lock.yaml"))).equals(originalBytes),
  "Source lock moved during construction",
);
assert(
  (await readFile(join(sourceRoot, "package.json"))).equals(originalManifest),
  "Source manifest moved during construction",
);
assert.equal(git(sourceRoot, "rev-parse", "HEAD"), sourceRevision);
assert.equal(git(sourceRoot, "rev-parse", "HEAD^{tree}"), sourceTree);
assert.equal(git(centralRoot, "rev-parse", "HEAD"), centralRevision);
assert(
  (await readFile(registryPath)).equals(registryBytes),
  "Central registry moved during construction",
);
await mkdir(outputArgument, { recursive: false });
const outputRoot = await realpath(outputArgument);
assert.equal(outputRoot, outputArgument, "Output parents must be canonical");
await writeFile(join(outputRoot, "pnpm-lock.yaml"), selectedBytes, { flag: "wx" });
await writeFile(join(outputRoot, "staging-package.json"), json(stagingManifest), { flag: "wx" });
const result = {
  status:
    "constructed-and-central-closure-compared; public-controller-acceptance-and-frozen-install-pending",
  sourceRoot,
  sourceRevision,
  sourceTree,
  centralRevision,
  cohortId,
  sourceLockSha256: digest(originalBytes),
  selectedLockSha256: digest(selectedBytes),
  sourceManifestSha256: digest(originalManifest),
  registeredClosureDigest: expectedDigest,
  observedClosureDigest: row(observed["authority"], "Missing observed authority")["digest"],
  sourceManagedSnapshots: managed.size,
  sourceForeignSnapshots: foreign.size,
  sharedSnapshots: [...managed].filter((key) => foreign.has(key)).length,
  replacedSnapshotCount: ownedSnapshots.size,
  protectedSnapshotConflicts: 0,
  foreignImportersAndSettingsPreserved: true,
  commentsPreserved: true,
  selectedLockPath: join(outputRoot, "pnpm-lock.yaml"),
  stagingManifestPurpose:
    "External cache/frozen-install fixture only; never copy this handwritten manifest into a consumer",
};
await writeFile(join(outputRoot, "composition.json"), json(result), { flag: "wx" });
console.log(json(result));
