const hermeticPrereleaseTag = "e2e-prerelease";

export function registryPublicationTag(version) {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("Registry publication requires a package version.");
  }
  return version.includes("-") ? hermeticPrereleaseTag : undefined;
}

export function registryPublishArguments({ archivePath, registryUrl, version }) {
  const publishArguments = [
    "publish",
    archivePath,
    "--registry",
    registryUrl,
    "--access",
    "public",
    "--ignore-scripts",
    "--provenance=false",
  ];
  const tag = registryPublicationTag(version);
  if (tag !== undefined) {
    publishArguments.push("--tag", tag);
  }
  return publishArguments;
}
