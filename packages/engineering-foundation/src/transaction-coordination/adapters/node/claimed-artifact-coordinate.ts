import { isExactVersion } from "../../../semantic-version.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Bounded display of untrusted claims; this does not validate an artifact. */
export function claimedArtifactCoordinate(value: unknown): string {
  const identity = record(value);
  const version = identity["version"];
  const build = identity["buildIdentity"];
  return typeof version === "string" && version.length <= 256 &&
    isExactVersion(version) &&
    typeof build === "string" && /^sha256:[0-9a-f]{64}$/u.test(build)
    ? `${version} (${build})`
    : "unavailable or malformed";
}
