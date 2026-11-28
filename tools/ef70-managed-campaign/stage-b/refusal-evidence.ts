import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  digest,
  evidence,
  parse,
  requireEqual,
  string,
  utf8,
  type JsonRecord,
} from "../stage-a/io.ts";
import { bytes, equal } from "./context.ts";
import { keys, type RefusalCase } from "./refusal-contracts.ts";

export function optionalFile(path: string, label: string): JsonRecord {
  if (!existsSync(path)) {
    return { path, state: "absent" };
  }
  const content = bytes(path),
    stat = lstatSync(path);
  evidence(label, content);
  return {
    path,
    state: "file",
    mode: stat.mode & 0o777,
    bytes: content.length,
    sha256: digest(content),
  };
}
interface StableLocalFile {
  readonly bytes: Buffer;
  readonly mode: number;
  readonly links: string;
}

function sameLocalFileIdentity(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.isFile() && right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs;
}

function sameLocalFileSnapshot(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return sameLocalFileIdentity(left, right) &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs;
}

// Retained atomic-publication evidence may legitimately have multiple hard links:
// the destination and quarantined evidence preserve the same inode. Do not weaken
// context.bytes(), which is reserved for single-link selected input files.
function readStableLocalEvidenceFile(path: string): StableLocalFile {
  const beforePath = lstatSync(path, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size > 64n * 1024n * 1024n || beforePath.nlink < 1n) {
    throw new Error("Local owner evidence is not one bounded regular file.");
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const beforeRead = fstatSync(descriptor, { bigint: true });
    if (!sameLocalFileIdentity(beforePath, beforeRead) || !sameLocalFileSnapshot(beforePath, beforeRead)) {
      throw new Error("Local owner evidence changed before its read.");
    }
    const content = Buffer.alloc(Number(beforeRead.size));
    let offset = 0;
    while (offset < content.length) {
      const count = readSync(descriptor, content, offset, content.length - offset, offset);
      if (count === 0) {
        throw new Error("Local owner evidence was truncated during its read.");
      }
      offset += count;
    }
    const afterRead = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (!sameLocalFileSnapshot(beforeRead, afterRead) || !sameLocalFileSnapshot(afterRead, afterPath)) {
      throw new Error("Local owner evidence changed during its read.");
    }
    return { bytes: content, mode: Number(afterRead.mode & 0o777n), links: afterRead.nlink.toString() };
  } finally {
    closeSync(descriptor);
  }
}

export function localEvidence(root: string, label: string): readonly JsonRecord[] {
  const directory = join(root, ".agent-teams-local");
  if (!existsSync(directory)) {
    return [{ path: ".agent-teams-local", state: "absent" }];
  }
  const entries: JsonRecord[] = [];
  let total = 0;
  function visit(path: string, name: string, depth: number): void {
    if (depth > 16 || entries.length >= 2048) {
      throw new Error("Local owner evidence exceeds capture bounds.");
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error("Local owner evidence contains a symlink.");
    }
    if (stat.isDirectory()) {
      entries.push({ path: name, state: "directory", mode: stat.mode & 0o777 });
      for (const child of readdirSync(path).toSorted()) {
        visit(join(path, child), `${name}/${child}`, depth + 1);
      }
    } else {
      const observed = readStableLocalEvidenceFile(path);
      const content = observed.bytes;
      total += content.length;
      if (total > 64 * 1024 * 1024) {
        throw new Error("Local owner evidence exceeds byte bound.");
      }
      evidence(`${label}/${name}`, content);
      entries.push({
        path: name,
        state: "file",
        mode: observed.mode,
        links: observed.links,
        bytes: content.length,
        sha256: digest(content),
      });
    }
  }
  visit(directory, ".agent-teams-local", 0);
  return entries;
}

export interface LocalEvidenceObservation {
  readonly state: "unchanged" | "released-lease-retained";
  readonly priorEvidenceUnchanged: true;
  readonly addedPaths: readonly string[];
  readonly retirement?: JsonRecord;
}
function observeRetiredOwner(
  root: string,
  retired: JsonRecord,
  childPid: number | undefined,
  uuid: string,
): JsonRecord {
  const retiredPath = string(retired["path"], "released evidence path");
  const raw = bytes(join(root, retiredPath), 8 * 1024);
  requireEqual(digest(raw), retired["sha256"], "same captured raw retirement bytes");
  const owner = parse(utf8(raw), "actual retired lease owner");
  keys(owner, ["host", "kind", "pid", "schemaVersion", "token"]);
  requireEqual(owner["schemaVersion"], 1, "actual lock schema");
  requireEqual(owner["kind"], "active", "released active owner, not a transaction barrier");
  requireEqual(owner["host"], hostname(), "actual retirement host");
  if (
    typeof owner["pid"] !== "number" ||
    !Number.isSafeInteger(owner["pid"]) ||
    owner["pid"] <= 0 ||
    typeof owner["token"] !== "string" ||
    !new RegExp(`^${uuid}$`, "u").test(owner["token"])
  ) {
    throw new Error("Retired owner has no valid actual PID/token.");
  }
  if (childPid === undefined) {
    throw new Error("No actual spawned child PID was observed.");
  }
  requireEqual(owner["pid"], childPid, "released lease belongs to the actual spawned CLI process");
  equal(
    raw,
    Buffer.from(
      `${JSON.stringify({ host: owner["host"], kind: "active", pid: owner["pid"], schemaVersion: 1, token: owner["token"] })}\n`,
    ),
    "exact source-owned lock encoding",
  );
  return owner;
}

export function verifyLocalEvidence(
  root: string,
  selected: RefusalCase,
  before: readonly JsonRecord[],
  after: readonly JsonRecord[],
  childPid: number | undefined,
): LocalEvidenceObservation {
  // These exact owner guards are inside the acquire/release lease try/finally,
  // before claimMutation. Release preserves one real active-owner lock image in
  // a fresh released.<UUID>/evidence directory; it deliberately never deletes it.
  if (
    !["foreign-image", "completed-republish", "host-overlap", "stale-current-head"].includes(
      selected,
    )
  ) {
    equal(after, before, "local CAS evidence unchanged before lease acquisition");
    return { state: "unchanged", priorEvidenceUnchanged: true, addedPaths: [] };
  }
  const localRoot = ".agent-teams-local";
  const terminalRoot = `${localRoot}/foundation-operation-lock.completed-evidence`;
  const previouslyAbsent =
    before.length === 1 && before[0]?.["path"] === localRoot && before[0]?.["state"] === "absent";
  const previous = new Map(
    (previouslyAbsent ? [] : before).map((entry) => [
      string(entry["path"], "previous local path"),
      entry,
    ]),
  );
  const current = new Map(
    after.map((entry) => [string(entry["path"], "current local path"), entry]),
  );
  requireEqual(current.size, after.length, "unique current local evidence paths");
  for (const [path, entry] of previous) {
    equal(current.get(path), entry, "prior local evidence preserved: " + path);
  }
  const added = after.filter((entry) => !previous.has(string(entry["path"], "added local path")));
  const addedFiles = added.filter((entry) => entry["state"] === "file");
  requireEqual(addedFiles.length, 1, "exactly one new released-lease evidence file");
  const retired = addedFiles[0]!,
    retiredPath = string(retired["path"], "released evidence path");
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  if (
    !new RegExp(
      `^\\.agent-teams-local/foundation-operation-lock\\.completed-evidence/released\\.${uuid}/evidence$`,
      "u",
    ).test(retiredPath)
  ) {
    throw new Error("Unexpected new local transaction, journal or evidence file.");
  }
  const retiredDirectory = retiredPath.slice(0, -"/evidence".length);
  const allowed = new Map([
    [localRoot, 0o777 & ~process.umask()],
    [terminalRoot, 0o700 & ~process.umask()],
    [retiredDirectory, 0o700 & ~process.umask()],
    [retiredPath, 0o600 & ~process.umask()],
  ]);
  for (const entry of added) {
    const path = string(entry["path"], "added local evidence path");
    if (!allowed.has(path)) {
      throw new Error("Unexpected new local CAS evidence path: " + path);
    }
    requireEqual(
      entry["state"],
      path === retiredPath ? "file" : "directory",
      "retirement path kind",
    );
    requireEqual(entry["mode"], allowed.get(path), "new owner evidence mode");
  }
  for (const path of [localRoot, terminalRoot, retiredDirectory]) {
    requireEqual(current.get(path)?.["state"], "directory", "required retirement parent");
  }
  if (previous.has(retiredDirectory)) {
    throw new Error("Retirement directory was not freshly created.");
  }
  const owner = observeRetiredOwner(root, retired, childPid, uuid);
  return {
    state: "released-lease-retained",
    priorEvidenceUnchanged: true,
    addedPaths: added.map((entry) => string(entry["path"], "added local evidence path")),
    retirement: {
      ...retired,
      owner,
      rawEvidence: `local-evidence-after/${retiredPath}`,
      sourceOrder:
        "The selected exact guard runs inside acquireMutationLease/releaseMutationLease before claimMutation. NodeMutationOperationLock.release retains the active lock through quarantineObservedLock(..., released).",
      pidIndependentlyObserved: true,
      spawnedChildPid: childPid,
      attribution:
        "The retirement host matches this host and its PID matches the OS-reported spawnSync child PID for the sole actual public CLI invocation. No process-tree completeness or unobserved transient-write claim is made.",
    },
  };
}
