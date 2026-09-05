import type { PublishablePackageEvidence } from "../../../application/model/repository-security.js";
import { readRequiredEvidenceFile } from "./repository-security-filesystem.js";
import {
  repositorySecurityInputError,
  requireRecord
} from "../../../application/policies/repository-security-input.js";

export async function readPublishablePackageEvidence(
  root: string,
  manifestPath: string
): Promise<PublishablePackageEvidence> {
  let input: unknown;
  try {
    input = JSON.parse((await readRequiredEvidenceFile(root, manifestPath)).toString("utf8")) as unknown;
  } catch {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_PACKAGE_INVALID",
      `Package manifest is not valid JSON: ${manifestPath}.`
    );
  }
  const manifest = requireRecord(input, `package manifest ${manifestPath}`);
  if (typeof manifest["name"] !== "string") {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_PACKAGE_INVALID",
      `Publishable package name is invalid: ${manifestPath}.`
    );
  }
  const files = manifest["files"];
  if (
    files !== undefined &&
    (!Array.isArray(files) || !files.every((entry) => typeof entry === "string"))
  ) {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_PACKAGE_INVALID",
      `Publishable package files must be strings: ${manifestPath}.`
    );
  }
  const publishConfig = manifest["publishConfig"];
  return Object.freeze({
    manifestPath,
    packageName: manifest["name"],
    ...(files === undefined ? {} : { files: Object.freeze(files) }),
    provenance:
      typeof publishConfig === "object" &&
      publishConfig !== null &&
      !Array.isArray(publishConfig) &&
      (publishConfig as Record<string, unknown>)["provenance"] === true
  });
}
