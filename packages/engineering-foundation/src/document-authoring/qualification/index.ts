import { lstat, open, realpath } from "node:fs/promises";
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

async function readFixtureMarker(path: string): Promise<unknown> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new TypeError(
      "Document authoring crash qualification requires a real regular fixture marker."
    );
  }
  if (metadata.size > MAX_FIXTURE_MARKER_BYTES) {
    throw new TypeError(
      `Document authoring crash qualification fixture marker exceeds ${MAX_FIXTURE_MARKER_BYTES} bytes.`
    );
  }
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(MAX_FIXTURE_MARKER_BYTES + 1);
    const { bytesRead } = await handle.read(
      bytes,
      0,
      bytes.byteLength,
      0
    );
    if (bytesRead > MAX_FIXTURE_MARKER_BYTES) {
      throw new TypeError(
        `Document authoring crash qualification fixture marker exceeds ${MAX_FIXTURE_MARKER_BYTES} bytes.`
      );
    }
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
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
  if ((await realpath(markerPath)) !== markerPath) {
    throw new TypeError(
      "Document authoring crash qualification fixture marker must be physically contained by consumerRoot."
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
