import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { executeCommand, row, type Row } from "../ef70-managed-campaign/campaign-io.ts";
import {
  regularImage,
  retainAt,
  sha256,
  list,
  relativePath,
  text,
} from "../ef70-managed-adoption/files.ts";
import type { RecoverySetup } from "./configuration.ts";

const maximumExpanded = 128 * 1024 * 1024;
export function admittedNames(raw: string, prefix: string): string[] {
  assert(raw.endsWith("\n") && !/[\0\r]/u.test(raw));
  const names = raw.slice(0, -1).split("\n");
  assert(names.length > 0 && names.length <= 10_000);
  const normalized = new Set<string>();
  for (const name of names) {
    assert(/^[A-Za-z0-9._/@+%-]+\/?$/u.test(name), "Unsupported archive name");
    relativePath(name.endsWith("/") ? name.slice(0, -1) : name);
    const key = name.replace(/\/$/u, "").toLowerCase();
    assert(!normalized.has(key), "Duplicate or colliding archive member");
    normalized.add(key);
    assert(
      name.startsWith(prefix) || name.startsWith(prefix.replace("ef70-evidence-", "ef70-quality-")),
      "Foreign artifact namespace",
    );
  }
  return names;
}
export function assertManifestEntry(content: Buffer, entry: Row): void {
  assert.equal(
    entry["kind"],
    "file",
    "Archive modes/links are not accepted as filesystem authority",
  );
  assert.equal(entry["bytes"], content.length);
  assert.equal(entry["sha256"], sha256(content));
}
export interface OriginalArchive {
  readonly marker: Row;
  readonly bootstrap: Row;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly archive: Row;
  readonly prefix: string;
}
export function inspectArchive(setup: RecoverySetup): OriginalArchive {
  const { artifact: selection } = setup;
  const names = readdirSync(setup.downloadRoot);
  assert.equal(names.length, 1, "One exact selected ZIP is required");
  const archivePath = join(setup.downloadRoot, names[0]!);
  const image = regularImage(archivePath, 512 * 1024 * 1024);
  assert(image.bytes > 0);
  assert.equal("sha256:" + image.sha256, selection.artifactDigest);
  const prefix = "ef70-evidence-" + selection.runId + "-" + selection.attempt + "/";
  let sequence = 0;
  const command = (label: string, args: readonly string[]): Buffer =>
    executeCommand({
      label,
      executable: "/usr/bin/unzip",
      args,
      cwd: setup.harness,
      observer: false,
      accepted: [0],
      environment: setup.environment,
      stem: join(setup.roots.evidenceRoot, "intake", String(++sequence) + "-" + label),
      timeoutMs: 120_000,
    }).stdout;
  const members = admittedNames(
    command("archive-list", ["-Z1", archivePath]).toString("utf8"),
    prefix,
  );
  const known = new Set(members);
  let total = 0;
  const files = new Map<string, Buffer>();
  const read = (name: string): Buffer => {
    relativePath(name);
    const existing = files.get(name);
    if (existing !== undefined) {
      return existing;
    }
    assert(known.has(prefix + name), "Missing unique artifact member: " + name);
    const content = command("archive-member", ["-p", archivePath, prefix + name]);
    total += content.length;
    assert(
      content.length <= 32 * 1024 * 1024 && total <= maximumExpanded,
      "Expanded evidence exceeds bound",
    );
    files.set(name, content);
    return content;
  };
  const parse = (name: string): Row => row(JSON.parse(read(name).toString("utf8")), name);
  const manifest = parse("artifact-manifest.json");
  assert.equal(manifest["schemaVersion"], 1);
  assert.equal(manifest["success"], true);
  assert.equal(manifest["selfExcluded"], true);
  const listed = new Set<string>();
  for (const value of list(manifest["files"], "Original complete file census")) {
    const entry = row(value, "Artifact image");
    const path = relativePath(entry["path"]);
    assert(!listed.has(path), "Duplicate manifest entry");
    listed.add(path);
    assertManifestEntry(read(path), entry);
  }
  const marker = parse("adoption-complete.json");
  assert.equal(
    row(marker["manifest"], "Original manifest selection")["sha256"],
    "sha256:" + sha256(read("artifact-manifest.json")),
  );
  const capsule = parse("evidence-capsule-manifest.json");
  assert.equal(capsule["schemaVersion"], 1);
  assert.equal(capsule["allCapturedMetadataUnchangedDuringRead"], true);
  assert.equal(capsule["fileCount"], listed.size + 2);
  const actual = members
    .filter((name) => name.startsWith(prefix) && !name.endsWith("/"))
    .map((name) => name.slice(prefix.length))
    .toSorted();
  assert.deepEqual(
    actual,
    [
      ...listed,
      "artifact-manifest.json",
      "adoption-complete.json",
      "evidence-capsule-manifest.json",
    ].toSorted(),
    "Unaccounted evidence member",
  );
  assert.deepEqual(regularImage(archivePath, 512 * 1024 * 1024), image);
  retainAt(
    setup.roots.evidenceRoot,
    "intake/archive-census.json",
    JSON.stringify({ image, prefix, members, expandedBytes: total }, null, 2) + "\n",
  );
  return {
    marker,
    bootstrap: parse("bootstrap-result.json"),
    files,
    prefix,
    archive: { ...image, digest: selection.artifactDigest },
  };
}
export function originalFile(archive: OriginalArchive, name: string): Buffer {
  const content = archive.files.get(name);
  assert(content !== undefined, "Missing authenticated original evidence: " + name);
  return content;
}
export function originalJson(archive: OriginalArchive, name: string): Row {
  return row(JSON.parse(originalFile(archive, name).toString("utf8")), text(name, "Original JSON"));
}
