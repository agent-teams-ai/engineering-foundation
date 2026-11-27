import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  digest,
  row,
  text,
  type Campaign,
  type PreparedCase,
  type Row,
} from "./campaign-support.ts";

interface Identity {
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}
interface FileObservation {
  readonly bytes: Buffer;
  readonly identity: Identity;
}
type ManifestImage =
  | { readonly path: string; readonly kind: "absent" }
  | {
      readonly path: string;
      readonly kind: "file";
      readonly identity: Identity;
      readonly sha256: string;
      readonly contentBase64: string;
    };
export interface InstallationSnapshot {
  readonly consumer: Identity;
  readonly modules: Identity;
  readonly manifests: readonly ManifestImage[];
}
const manifests = [
  "@agent-teams/repository-mutation",
  "@agent-teams/document-authoring",
  "@agent-teams/docs-protocol",
  "@agent-teams/docs-protocol-agent-teams",
  "@agent-teams/engineering-foundation",
];
const backupPrefix = ".docs-consumer-upgrade-modules-";

export function absent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function identity(stat: BigIntStats): Identity {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    birthtimeNs: String(stat.birthtimeNs),
    mode: Number(stat.mode & 0o777n),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
  };
}
function sameIdentity(left: Identity, right: Identity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}
export function directory(path: string): Identity {
  assert(isAbsolute(path) && resolve(path) === path);
  assert.equal(realpathSync(path), path, "Directory must be canonical without aliases");
  const stat = lstatSync(path, { bigint: true });
  assert(stat.isDirectory() && !stat.isSymbolicLink(), "Owned real directory required");
  assert.equal(Number(stat.uid), process.geteuid?.(), "Directory must belong to this runner");
  return identity(stat);
}
export function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (absent(error)) {
      return false;
    }
    throw error;
  }
}
export function inside(parent: string, child: string): void {
  const path = relative(parent, child);
  assert(path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep));
}
export function readBounded(path: string, maximum = 32 * 1024 * 1024): FileObservation {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    assert(before.isFile() && before.nlink === 1n && before.size <= BigInt(maximum));
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) {
        break;
      }
      length += count;
    }
    const after = fstatSync(fd, { bigint: true }),
      selected = lstatSync(path, { bigint: true });
    assert(selected.isFile() && !selected.isSymbolicLink() && selected.nlink === 1n);
    assert(
      sameIdentity(identity(before), identity(after)) &&
        sameIdentity(identity(before), identity(selected)),
    );
    assert(
      before.size === after.size &&
        before.size === selected.size &&
        before.mtimeNs === after.mtimeNs &&
        before.mtimeNs === selected.mtimeNs &&
        before.ctimeNs === after.ctimeNs &&
        before.ctimeNs === selected.ctimeNs &&
        length === Number(before.size),
    );
    return { bytes: buffer.subarray(0, length), identity: identity(before) };
  } finally {
    closeSync(fd);
  }
}
export function json(path: string): Row {
  return row(JSON.parse(readBounded(path).bytes.toString("utf8")), path);
}
export function backups(root: string): readonly string[] {
  return readdirSync(root)
    .filter((name) => name.startsWith(backupPrefix))
    .toSorted();
}
function manifestImage(modules: string, name: string): ManifestImage {
  const path = join(name, "package.json"),
    selected = join(modules, path);
  if (!present(selected)) {
    return { path, kind: "absent" };
  }
  inside(modules, realpathSync(selected));
  const image = readBounded(selected, 2 * 1024 * 1024);
  return {
    path,
    kind: "file",
    identity: image.identity,
    sha256: digest(image.bytes),
    contentBase64: image.bytes.toString("base64"),
  };
}
export function installation(
  root: string,
  modules = join(root, "node_modules"),
): InstallationSnapshot {
  return {
    consumer: directory(root),
    modules: directory(modules),
    manifests: manifests.map((name) => manifestImage(modules, name)),
  };
}
export function ownedCase(campaign: Campaign, selected: PreparedCase): void {
  assert.equal(dirname(selected.root), campaign.root);
  assert(/^case-[a-z0-9][a-z0-9-]{0,63}$/u.test(basename(selected.root)));
  directory(selected.root);
  directory(selected.evidence);
  inside(campaign.evidenceRoot, selected.evidence);
  assert.deepEqual(campaign.selected(selected.preparation.path), selected.preparation);
}

/** Observe the genuine installation before the separately owned interruption. */
export function captureInstallation(
  campaign: Campaign,
  selected: PreparedCase,
  label: string,
): InstallationSnapshot {
  ownedCase(campaign, selected);
  assert.deepEqual(
    backups(selected.root),
    [],
    "Prior installer debt requires owner reconciliation",
  );
  const snapshot = installation(selected.root);
  campaign.record(selected.name + "-" + label, {
    observedAt: new Date().toISOString(),
    consumerRoot: selected.root,
    snapshot,
    scope:
      "Physical module-root custody and five selected manifests; not a full installed-file inventory.",
  });
  return snapshot;
}

export function observeAttemptDebt(campaign: Campaign, label: string): void {
  const temporary = text(campaign.environment["TMPDIR"], "owned temporary directory");
  const namespaces = [...new Set([campaign.root, temporary])];
  const records: Row[] = [];
  for (const namespace of namespaces) {
    directory(namespace);
    const names = readdirSync(namespace);
    assert(names.length <= 8192);
    for (const name of names.filter((entry) =>
      /^managed-runtime-.*\.json(?:\.release-debt)?$/u.test(entry),
    )) {
      const path = join(namespace, name),
        observed = readBounded(path, 256 * 1024);
      records.push({
        path,
        identity: observed.identity,
        sha256: digest(observed.bytes),
        contentBase64: observed.bytes.toString("base64"),
      });
    }
  }
  campaign.record(label, {
    namespaces,
    records,
    scope:
      "Direct recorded host-owned runtime namespaces only. Existing records are barriers, never restart leases.",
  });
  assert.equal(records.length, 0, "Retained runtime attempt/debt requires its existing owner");
}

/** Preserve partial output and restore only a physically authenticated old installation. */
export function reconcileInstallation(
  campaign: Campaign,
  selected: PreparedCase,
  label: string,
  captured?: InstallationSnapshot,
): void {
  const names = backups(selected.root);
  campaign.record(label + "-installation-before", {
    consumer: directory(selected.root),
    backups: names,
    current: present(join(selected.root, "node_modules")) ? installation(selected.root) : null,
  });
  if (captured !== undefined) {
    assert.deepEqual(directory(selected.root), captured.consumer);
  }
  if (names.length === 0) {
    const current = installation(selected.root);
    campaign.record(label + "-installation-ready", {
      current,
      originalRootRetained:
        captured !== undefined && sameIdentity(current.modules, captured.modules),
      repaired: false,
      completenessClaimed: false,
    });
    return;
  }
  assert(captured !== undefined, "Backup restoration requires an actual before-cold snapshot");
  assert.equal(names.length, 1, "Ambiguous installer backup custody");
  const backup = join(selected.root, names[0]!);
  const backupIdentity = directory(backup),
    entries = readdirSync(backup).toSorted();
  const modules = join(selected.root, "node_modules");
  if (entries.length === 0) {
    assert.deepEqual(
      installation(selected.root),
      captured,
      "Empty backup needs the intact original modules",
    );
  } else {
    assert.deepEqual(entries, ["node_modules"], "Preserve unexpected backup contents");
    assert.deepEqual(
      installation(selected.root, join(backup, "node_modules")),
      captured,
      "Backup must retain the captured original root and selected manifest identities",
    );
  }
  const quarantine = mkdtempSync(
    join(campaign.root, "case-" + selected.name + "-interrupted-installation-"),
  );
  const quarantineIdentity = directory(quarantine);
  assert.equal(
    quarantineIdentity.device,
    backupIdentity.device,
    "Quarantine must use the same filesystem",
  );
  const partial = entries.length > 0 && present(modules) ? installation(selected.root) : null;
  if (partial !== null) {
    assert(!sameIdentity(partial.modules, captured.modules));
    assert.equal(partial.modules.device, quarantineIdentity.device);
  }
  campaign.record(label + "-installation-rename-intent", {
    backup,
    backupIdentity,
    captured,
    quarantine,
    quarantineIdentity,
    partial,
    operation:
      "Only rename observed owned directories; preserve partial modules and empty backup shell.",
  });
  if (entries.length > 0) {
    if (partial !== null) {
      assert.deepEqual(installation(selected.root), partial);
      renameSync(modules, join(quarantine, "partial-node_modules"));
    } else {
      assert.equal(present(modules), false);
    }
    assert.deepEqual(installation(selected.root, join(backup, "node_modules")), captured);
    assert.equal(present(modules), false);
    renameSync(join(backup, "node_modules"), modules);
  }
  assert.deepEqual(directory(backup), backupIdentity);
  assert.deepEqual(readdirSync(backup), []);
  renameSync(backup, join(quarantine, "installer-backup-directory"));
  assert.deepEqual(installation(selected.root), captured);
  assert.deepEqual(backups(selected.root), []);
  campaign.record(label + "-installation-ready", {
    repaired: true,
    captured,
    quarantine,
    current: installation(selected.root),
    noDeletionPerformed: true,
    completenessClaimed: false,
  });
}
