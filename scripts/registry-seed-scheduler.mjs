function packageName(entry) {
  const name = entry?.manifest?.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Registry seed entries require a package name.");
  }
  return name;
}

function groupPackageVersions(dependencies) {
  const groups = new Map();
  for (const [index, entry] of dependencies.entries()) {
    const name = packageName(entry);
    const group = groups.get(name) ?? [];
    group.push({ entry, index });
    groups.set(name, group);
  }
  return [...groups.values()];
}

export async function seedRegistryInParallel({
  concurrency,
  dependencies,
  packPackage,
  publishArchive,
  registryUrl,
}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Registry seed concurrency must be a positive integer.");
  }
  const groups = groupPackageVersions(dependencies);
  let nextGroupIndex = 0;

  async function seedNextGroups() {
    while (nextGroupIndex < groups.length) {
      const group = groups[nextGroupIndex];
      nextGroupIndex += 1;
      for (const { entry, index } of group) {
        const archivePath = await packPackage(entry, index);
        await publishArchive(
          archivePath,
          registryUrl,
          entry.manifest.version,
        );
      }
    }
  }

  const workerCount = Math.min(concurrency, groups.length);
  const results = await Promise.allSettled(
    Array.from({ length: workerCount }, () => seedNextGroups()),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure !== undefined) {
    throw failure.reason;
  }
}
