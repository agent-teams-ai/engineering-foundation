import { isExactVersion } from "../../../../semantic-version.js";
import type { PackageReleaseEvidence } from "../model/public-api.js";

type InitialReleasePolicyFailure =
  | "package-mismatch"
  | "version-not-initial"
  | "changeset-missing"
  | "changeset-insufficient";

export type InitialReleasePolicyResult =
  | { readonly status: "accepted" }
  | { readonly status: "rejected"; readonly failure: InitialReleasePolicyFailure };

export const initialUnreleasedVersion = "0.0.0" as const;

/** First-surface release policy; publication absence is independently qualified. */
export function evaluateInitialReleasePolicy(
  expectedPackageName: string,
  releaseEvidence: PackageReleaseEvidence
): InitialReleasePolicyResult {
  if (releaseEvidence.packageName !== expectedPackageName) {
    return { status: "rejected", failure: "package-mismatch" };
  }
  if (!isExactVersion(releaseEvidence.packageVersion)) {
    return { status: "rejected", failure: "version-not-initial" };
  }
  if (releaseEvidence.declaredBump === undefined) {
    return { status: "rejected", failure: "changeset-missing" };
  }
  if (releaseEvidence.declaredBump === "patch") {
    return { status: "rejected", failure: "changeset-insufficient" };
  }
  return { status: "accepted" };
}

/** Missing v1 baselines may only be created at the adoption bootstrap version. */
export function evaluateBaselineBootstrapPolicy(
  expectedPackageName: string,
  releaseEvidence: PackageReleaseEvidence
): InitialReleasePolicyResult {
  if (releaseEvidence.packageName === expectedPackageName && releaseEvidence.packageVersion !== initialUnreleasedVersion) {
    return { status: "rejected", failure: "version-not-initial" };
  }
  return evaluateInitialReleasePolicy(expectedPackageName, releaseEvidence);
}
