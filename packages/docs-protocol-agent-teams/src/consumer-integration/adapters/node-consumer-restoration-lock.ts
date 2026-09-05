import { isNode, parseDocument, visit } from "yaml";
import type { ConsumerIntegrationDesiredStateV1, ConsumerIntegrationDesiredStateV3 } from "../domain/model.js";
import { requireRestoration, restorationJson } from "../application/policies/consumer-restoration-proof.js";
import { assertQualifiedPnpmLockfileV1 } from "./pnpm-lockfile-validator-v1.js";
import { assertQualifiedPnpmLockfileV2 } from "./pnpm-lockfile-validator-v2.js";

type RecordValue = Record<string, unknown>;
const managedRoots = new Set(["@agent-teams/docs-protocol", "@agent-teams/engineering-foundation", "@agent-teams/docs-protocol-agent-teams"]);
const sections = ["dependencies", "devDependencies", "optionalDependencies"];
function record(value: unknown): RecordValue {
  requireRestoration(value !== null && typeof value === "object" && !Array.isArray(value), "invalid lock mapping.");
  return value as RecordValue;
}
function parse(bytes: Uint8Array) {
  const document = parseDocument(new TextDecoder("utf-8", { fatal: true }).decode(bytes), { uniqueKeys: true });
  requireRestoration(document.errors.length === 0, "invalid lock YAML.");
  const comments = [document.commentBefore, document.comment].filter((value): value is string => typeof value === "string");
  visit(document, (_key, node) => {
    if (!isNode(node)) {return;}
    for (const value of [node.commentBefore, node.comment]) {if (typeof value === "string") {comments.push(value);}}
  });
  return { value: record(document.toJS({ maxAliasCount: 0 })), comments: comments.toSorted() };
}
function closure(lock: RecordValue, roots: readonly string[]): Set<string> {
  const snapshots = record(lock["snapshots"]);
  const visited = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (visited.has(key)) {continue;}
    requireRestoration(visited.size < 8192, "lock scope exceeds bounded graph.");
    // Unrelated workspace/link dependencies remain verbatim in their importer.
    if (!Object.hasOwn(snapshots, key)) {continue;}
    visited.add(key);
    const snapshot = record(snapshots[key]);
    for (const section of ["dependencies", "optionalDependencies"]) {
      for (const [name, version] of Object.entries(record(snapshot[section] ?? {}))) {
        requireRestoration(typeof version === "string", "invalid lock resolution.");
        pending.push(`${name}@${version}`);
      }
    }
  }
  return visited;
}
function nonOwnedProjection(lock: RecordValue): RecordValue {
  const copy = structuredClone(lock);
  const importers = record(copy["importers"]);
  const owned: string[] = [];
  const foreign: string[] = [];
  for (const [path, rawImporter] of Object.entries(importers)) {
    const importer = record(rawImporter);
    for (const section of sections) {
      const entries = record(importer[section] ?? {});
      for (const [name, value] of Object.entries(entries)) {
        const binding = record(value);
        requireRestoration(typeof binding["version"] === "string", "invalid importer resolution.");
        const isOwned = path === "." && section === "devDependencies" && managedRoots.has(name);
        (isOwned ? owned : foreign).push(`${name}@${binding["version"]}`);
        if (isOwned) {delete entries[name];}
      }
      // pnpm removes empty dependency sections; normalize only this structural difference.
      if (Object.keys(entries).length === 0) {delete importer[section];}
    }
  }
  const managed = closure(lock, owned);
  const preserved = closure(lock, foreign);
  const preservedPackages = new Set([...preserved].map((key) => key.split("(", 1)[0]!));
  const snapshots = record(copy["snapshots"]);
  const packages = record(copy["packages"]);
  for (const key of managed) {
    if (!preserved.has(key)) {delete snapshots[key];}
    const physical = key.split("(", 1)[0]!;
    if (!preservedPackages.has(physical)) {delete packages[physical];}
  }
  return copy;
}

export function assertRestorationLockScope(before: Uint8Array, after: Uint8Array,
  source: ConsumerIntegrationDesiredStateV1, target: ConsumerIntegrationDesiredStateV3): void {
  // Existing qualification validates exact coordinates, registry provenance, edges and closure digests.
  assertQualifiedPnpmLockfileV1(before, source);
  assertQualifiedPnpmLockfileV2(after, target);
  const sourceLock = parse(before), targetLock = parse(after);
  requireRestoration(restorationJson(sourceLock.comments) === restorationJson(targetLock.comments),
    "lock migration changes consumer comments.");
  requireRestoration(restorationJson(nonOwnedProjection(sourceLock.value)) === restorationJson(nonOwnedProjection(targetLock.value)),
    "lock migration changes non-owned policy, importers, dependencies or package graphs.");
}
