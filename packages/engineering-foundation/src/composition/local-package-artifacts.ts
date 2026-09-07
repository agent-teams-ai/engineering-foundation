import { FOUNDATION_SCHEMA_IDS } from "../schema-ids.js";
import { createFoundationPackageArtifactPolicy } from "../local-mode/api.js";

export const FOUNDATION_PACKAGE_ARTIFACT_POLICY = createFoundationPackageArtifactPolicy(FOUNDATION_SCHEMA_IDS);
export const FOUNDATION_REQUIRED_ARTIFACT_PATHS = FOUNDATION_PACKAGE_ARTIFACT_POLICY.requiredArtifactPaths;
export const FOUNDATION_PACKAGE_FILE_ALLOWLIST = FOUNDATION_PACKAGE_ARTIFACT_POLICY.packageFileAllowlist;
