import type {
  GrowthAuthorityRequest,
  GrowthAuthorityGrant,
  GrowthAuthorityPackedEvidence,
  GrowthAuthorityBinding,
} from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-authority.js";
import type {
  GrowthDigest,
  GrowthSurfaceObservation,
} from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-observation.js";
import type { ChangeFingerprint } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/ports/change-fingerprint.js";
export type MutableFixture<T> = { -readonly [K in keyof T]: MutableFixture<T[K]> };
type DraftRequest = MutableFixture<GrowthAuthorityRequest>;
export type DraftGrant = MutableFixture<GrowthAuthorityGrant>;
export type DraftPacked = MutableFixture<GrowthAuthorityPackedEvidence>;
export type DraftBinding = MutableFixture<GrowthAuthorityBinding>;
export interface GrowthAuthorityFixturePorts {
  request(this: void, operation?: "check" | "promote-release"): DraftRequest;
  grant(this: void, request: GrowthAuthorityRequest): DraftGrant;
  validateGrowthAuthorityGrant(
    this: void,
    value: unknown,
    request: GrowthAuthorityRequest,
    fingerprint: ChangeFingerprint,
    now: Date,
  ): GrowthAuthorityGrant;
  fingerprint: ChangeFingerprint;
  now: Date;
  d(this: void, character: string): GrowthDigest;
  observation(
    this: void,
    packageName?: string,
    status?: "complete" | "limited",
  ): MutableFixture<GrowthSurfaceObservation>;
  packed(
    this: void,
    packageName: string,
    version: string,
    observation: GrowthSurfaceObservation,
    payload?: string,
  ): DraftPacked;
  initialPackage(
    this: void,
    value: DraftGrant,
    request: DraftRequest,
    name?: string,
    payload?: string,
  ): void;
  releasedPackage(this: void, value: DraftGrant, request: DraftRequest): void;
  sealEvidence(this: void, value: DraftGrant, request: DraftRequest): void;
}
