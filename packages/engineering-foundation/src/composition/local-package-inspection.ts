import { inspectFoundationPackage as inspectPackage } from "../local-mode/node.js";
import type { FoundationPackageSelfCheck } from "../local-mode/api.js";
import { FOUNDATION_PACKAGE_ARTIFACT_POLICY } from "./local-package-artifacts.js";

export async function inspectFoundationPackage(packageRoot: string): Promise<FoundationPackageSelfCheck> {
  return inspectPackage(packageRoot, FOUNDATION_PACKAGE_ARTIFACT_POLICY);
}
