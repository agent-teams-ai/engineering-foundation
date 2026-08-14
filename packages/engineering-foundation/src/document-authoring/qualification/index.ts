import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

import type { DocumentPlanV2 } from "../application/model/document-planning.js";
import { applyNodeDocumentationPlanPrivately } from "../composition/node-document-writing-private.js";

export type {
  DocumentCompilerIdentity,
  DocumentIntent,
  DocumentJsonObject,
  DocumentJsonPrimitive,
  DocumentJsonValue,
  DocumentPlan,
  DocumentPlanCommon,
  DocumentPlanDiagnostic,
  DocumentPlanV2
} from "../application/model/document-planning.js";
export type {
  DocumentAuthorityDigest,
  DocumentAuthorityEvidence
} from "../application/model/document-catalog.js";
export type { DocumentParentMaterializationPlanV2 } from "../application/model/document-parent-materialization.js";

const FIXTURE_MARKER = ".agent-teams-document-authoring-qualification-fixture.json";
const MAX_FIXTURE_MARKER_BYTES = 4 * 1024;

export type DocumentAuthoringQualificationCrashPoint =
  "after-publishing-journal-durable";

export interface RunDocumentAuthoringCrashQualificationRequest {
  readonly consumerRoot: string;
  readonly plan: DocumentPlanV2;
  readonly crashPoint: DocumentAuthoringQualificationCrashPoint;
}

export interface DocumentAuthoringCrashQualificationResult {
  readonly schemaVersion: 1;
  readonly crashPoint: DocumentAuthoringQualificationCrashPoint;
  readonly state: "apply-completed-before-crash-point";
}

interface QualificationFixtureMarker {
  readonly schemaVersion: 1;
  readonly kind: "agent-teams-document-authoring-qualification-fixture";
  readonly consumerRoot: string;
}

function isClosedFixtureMarker(
  value: unknown,
  canonicalRoot: string
): value is QualificationFixtureMarker {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).toSorted().join("\0") ===
      ["consumerRoot", "kind", "schemaVersion"].toSorted().join("\0") &&
    candidate["schemaVersion"] === 1 &&
    candidate["kind"] ===
      "agent-teams-document-authoring-qualification-fixture" &&
    candidate["consumerRoot"] === canonicalRoot;
}

function sameIdentity(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readAtMost(handle: FileHandle, maximumBytes: number): Promise<Buffer | undefined> {
  const bytes = Buffer.allocUnsafe(maximumBytes + 1);
  let total = 0;
  while (total <= maximumBytes) {
    const { bytesRead } = await handle.read(bytes, total, bytes.byteLength - total, null);
    if (bytesRead === 0) {return bytes.subarray(0, total);}
    total += bytesRead;
  }
  return undefined;
}

async function readFixtureMarker(path: string): Promise<unknown> {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const nonBlocking = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
  const handle = await open(path, constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const metadata = await handle.stat({ bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new TypeError(
        "Document authoring crash qualification requires a real regular fixture marker."
      );
    }
    if (metadata.size > BigInt(MAX_FIXTURE_MARKER_BYTES)) {
      throw new TypeError(
        `Document authoring crash qualification fixture marker exceeds ${MAX_FIXTURE_MARKER_BYTES} bytes.`
      );
    }
    const physical = await realpath(path);
    if (physical !== path) {
      throw new TypeError(
        "Document authoring crash qualification fixture marker must not traverse symlinks."
      );
    }
    const pathHandle = await open(physical, constants.O_RDONLY | noFollow | nonBlocking);
    try {
      const pathMetadata = await pathHandle.stat({ bigint: true });
      if (!pathMetadata.isFile() || !sameIdentity(metadata, pathMetadata)) {
        throw new TypeError(
          "Document authoring crash qualification fixture marker identity changed before its bounded read."
        );
      }
    } finally {
      await pathHandle.close();
    }
    const bytes = await readAtMost(handle, MAX_FIXTURE_MARKER_BYTES);
    if (bytes === undefined) {
      throw new TypeError(
        `Document authoring crash qualification fixture marker exceeds ${MAX_FIXTURE_MARKER_BYTES} bytes.`
      );
    }
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(metadata, after) || after.size !== metadata.size || after.mtimeNs !== metadata.mtimeNs || after.size !== BigInt(bytes.byteLength)) {
      throw new TypeError(
        "Document authoring crash qualification fixture marker changed during its bounded read."
      );
    }
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await handle.close();
  }
}

async function assertOwnedDisposableFixture(consumerRoot: string): Promise<string> {
  if (!isAbsolute(consumerRoot) || resolvePath(consumerRoot) !== consumerRoot) {
    throw new TypeError(
      "Document authoring crash qualification requires an absolute normalized consumerRoot."
    );
  }
  const rootMetadata = await lstat(consumerRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new TypeError(
      "Document authoring crash qualification requires a real consumer directory."
    );
  }
  const canonicalRoot = await realpath(consumerRoot);
  if (canonicalRoot !== consumerRoot) {
    throw new TypeError(
      "Document authoring crash qualification consumerRoot must be canonical and cannot traverse symlinks."
    );
  }
  const markerPath = join(canonicalRoot, FIXTURE_MARKER);
  const marker = await readFixtureMarker(markerPath);
  if (!isClosedFixtureMarker(marker, canonicalRoot)) {
    throw new TypeError(
      "Document authoring crash qualification requires its exact closed fixture ownership marker."
    );
  }
  return canonicalRoot;
}

async function signalCheckpoint(
  crashPoint: DocumentAuthoringQualificationCrashPoint
): Promise<void> {
  const line = `${JSON.stringify({
    schemaVersion: 1,
    event: "document-authoring-qualification-crash-point",
    crashPoint
  })}\n`;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(line, (error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

/**
 * Runs a real document apply until the selected durable crash checkpoint.
 * The process intentionally remains pending after signalling and must be killed
 * by the qualification harness.
 */
export async function runDocumentAuthoringCrashQualification(
  request: RunDocumentAuthoringCrashQualificationRequest
): Promise<DocumentAuthoringCrashQualificationResult> {
  const consumerRoot = await assertOwnedDisposableFixture(request.consumerRoot);
  await applyNodeDocumentationPlanPrivately(
    { consumerRoot, plan: request.plan },
    {
      faultInjector: async (point) => {
        if (point.phase !== request.crashPoint) {
          return;
        }
        await signalCheckpoint(request.crashPoint);
        await new Promise<never>(() => {});
      }
    }
  );
  return {
    schemaVersion: 1,
    crashPoint: request.crashPoint,
    state: "apply-completed-before-crash-point"
  };
}
