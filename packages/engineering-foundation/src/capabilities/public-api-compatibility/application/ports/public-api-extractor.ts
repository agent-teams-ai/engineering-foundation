import type {
  PublicApiPackagePolicy,
  PublicApiSnapshot
} from "../model/public-api.js";

export interface PublicApiExtractor {
  extract(
    consumerRoot: string,
    policy: PublicApiPackagePolicy,
    packageVersion: string,
    signal?: AbortSignal
  ): Promise<PublicApiSnapshot>;
}
