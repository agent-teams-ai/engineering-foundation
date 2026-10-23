import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  GrowthAuthorityGrant,
  GrowthAuthorityRequest,
  GrowthAuthorityPackedEvidence,
  GrowthCoordinate,
  GrowthDigest,
  GrowthInvocation,
  GrowthObservationReference,
  GrowthSurfaceObservation,
  GrowthInstalledInventoryReader,
  PublicApiSnapshot,
} from "../packages/engineering-foundation/dist/sdk-growth-authority.js";

export type AuthorityApi = Pick<
  typeof import("../packages/engineering-foundation/dist/sdk-growth-authority.js"),
  | "decodeRequest"
  | "encodeGrant"
  | "decodeCompletion"
  | "encodeReceipt"
  | "createSdkGrowthAuthorityVerifier"
>;
export interface FixtureInput {
  installedConsumerRoot: string;
  repositoryRoot: string;
  config: {
    packages: readonly [{ releasedBaselinePath: string }, ...{ releasedBaselinePath: string }[]];
    sdkGrowth: { reportPath: string };
  };
  matchedReport: {
    candidate: { value: GrowthObservationReference };
    tool: GrowthInvocation["tool"];
  };
  trustedBase: GrowthSurfaceObservation;
  baseReference: GrowthObservationReference;
  releasedTyped: PublicApiSnapshot;
  releasedArtifact: PublicApiSnapshot;
  decision: {
    decisionId: string;
    ownerRef: string;
    transitions: readonly GrowthDigest[];
    coordinates: readonly GrowthCoordinate[];
    consumerEvidenceRefs: readonly unknown[];
  };
  packageName: string;
  positivePromotion?: boolean;
  candidateVersion?: string;
  foundationArchivePath: string;
  expectedTyped?: PublicApiSnapshot;
  expectedArtifact?: PublicApiSnapshot;
  releasedArchivePath: string;
  candidateArchivePath: string;
  candidateObservation: GrowthSurfaceObservation;
}
export type CompletionContext = {
  request: GrowthAuthorityRequest;
  grant: GrowthAuthorityGrant;
  finalizedReportBytes: Buffer;
};
export type InstalledFile = { path: string; contentHex: string };
export function errorReason(error: unknown): unknown {
  return typeof error === "object" && error !== null && "reason" in error
    ? error.reason
    : undefined;
}
export function errorMessage(error: unknown): unknown {
  return typeof error === "object" && error !== null && "message" in error
    ? error.message
    : undefined;
}
export function jsonRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
export function jsonString(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
export const controlledNow = () => new Date("2026-09-20T12:00:00.000Z");

export async function withinAuthorityDeadline<Input extends object, Result>(
  operation: (input: Input & { signal: AbortSignal }) => Promise<Result>,
  input: Input,
): Promise<Result> {
  const started = performance.now();
  const result = await operation({ ...input, signal: AbortSignal.timeout(120_000) });
  assert.ok(
    performance.now() - started < 120_000,
    "Installed authority operation must meet the unchanged 120s deadline.",
  );
  return result;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export const digest = (value: unknown): GrowthDigest =>
  `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
export const archiveIdentity = (
  bytes: string | Uint8Array,
): { archiveDigest: GrowthDigest; archiveIntegrity: string } => ({
  archiveDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  archiveIntegrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
});
export const compareCanonical = (left: unknown, right: unknown) =>
  canonicalJson(left) < canonicalJson(right)
    ? -1
    : canonicalJson(left) > canonicalJson(right)
      ? 1
      : 0;

export function canonicalCustody(
  files: readonly InstalledFile[],
): GrowthAuthorityPackedEvidence["custodyEvidence"] {
  const sorted = files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const archivePayload = canonicalJson({
    schemaVersion: "foundation:sdk-growth:archive:1",
    files: sorted,
  });
  const archiveManifest = sorted.map((file) => ({
    path: file.path,
    digest: archiveIdentity(Buffer.from(file.contentHex, "hex")).archiveDigest,
  }));
  return {
    ...archiveIdentity(archivePayload),
    archivePayload,
    archiveManifest,
    installedFiles: archiveManifest,
  };
}

export async function installedFiles(directory: string, prefix = ""): Promise<InstalledFile[]> {
  const output: InstalledFile[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`,
      path = join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await installedFiles(path, `${relative}/`)));
    } else if (entry.isFile()) {
      output.push({ path: relative, contentHex: (await readFile(path)).toString("hex") });
    } else {
      throw new Error("Unexpected installed archive member.");
    }
  }
  return output.toSorted((left, right) => left.path.localeCompare(right.path));
}

export function installedInventoryReader(
  installations: Map<GrowthDigest, string>,
): GrowthInstalledInventoryReader {
  return {
    async read(identity, cancellation) {
      cancellation.throwIfCancelled();
      const root = installations.get(identity.archiveDigest);
      if (root === undefined || root.length === 0) {
        throw new Error("Unknown installed custody identity.");
      }
      return (await installedFiles(root)).map((file) => ({
        path: file.path,
        bytes: Buffer.from(file.contentHex, "hex"),
      }));
    },
  };
}
