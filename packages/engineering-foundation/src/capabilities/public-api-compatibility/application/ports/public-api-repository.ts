import type {
  PackageReleaseEvidence,
  PublicApiPackagePolicy,
  PublicApiSnapshot
} from "../model/public-api.js";

export interface PublicApiRepository {
  describeReleasedBaselineWrite(
    consumerRoot: string,
    policy: PublicApiPackagePolicy,
    snapshot: PublicApiSnapshot,
    mode: "create" | "replace"
  ): Promise<{
    readonly destination: string;
    readonly operation: "create" | "replace";
    readonly preimageDigest: `sha256:${string}` | null;
    readonly proposedDigest: `sha256:${string}`;
  }>;

  readReleasedBaseline(
    consumerRoot: string,
    policy: PublicApiPackagePolicy,
    signal: AbortSignal | undefined,
    purpose: "release-promotion"
  ): Promise<PublicApiSnapshot | undefined>;

  readReleasedBaseline(
    consumerRoot: string,
    policy: PublicApiPackagePolicy,
    signal?: AbortSignal,
    purpose?: "compatibility-check"
  ): Promise<PublicApiSnapshot>;

  readReleaseEvidence(
    consumerRoot: string,
    changesetDirectory: string,
    policy: PublicApiPackagePolicy,
    signal?: AbortSignal
  ): Promise<PackageReleaseEvidence>;

  writeReleasedBaseline(
    consumerRoot: string,
    policy: PublicApiPackagePolicy,
    snapshot: PublicApiSnapshot,
    signal?: AbortSignal,
    mode?: "create" | "replace"
  ): Promise<void>;
}
