import { performance } from "node:perf_hooks";
import { join } from "node:path";

export const registryInstallAttemptPolicy = Object.freeze({
  firstAttemptTimeoutMs: 120_000,
  retryAttemptTimeoutMs: 240_000,
  retryDelayMs: 1_000,
});

const wait = (delayMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

function confirmedTimeout(error) {
  return (
    error?.timedOut === true &&
    error?.killed === true &&
    error?.terminationConfirmed === true
  );
}

export function registryInstallAttemptPaths(root, attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("Registry install attempt must be a positive integer.");
  }
  const consumerRoot = join(root, "consumer", `attempt-${attempt}`);
  const clientRoot = join(root, "npm-client", `attempt-${attempt}`);
  return Object.freeze({
    cacheRoot: join(clientRoot, "cache"),
    clientRoot,
    consumerRoot,
    userConfigPath: join(clientRoot, "npmrc"),
  });
}

export async function installRegistryConsumerWithRetry({
  cleanupAttempt = async () => {},
  createAttempt,
  delay = wait,
  onRetry = () => {},
  runInstall,
}) {
  const attempts = [
    registryInstallAttemptPolicy.firstAttemptTimeoutMs,
    registryInstallAttemptPolicy.retryAttemptTimeoutMs,
  ];
  for (const [index, timeoutMs] of attempts.entries()) {
    const attempt = index + 1;
    const context = await createAttempt(attempt);
    try {
      return await runInstall(context, { attempt, timeoutMs });
    } catch (error) {
      if (attempt !== 1 || !confirmedTimeout(error)) {
        throw error;
      }
      await cleanupAttempt(context);
      onRetry({
        attempt: 2,
        delayMs: registryInstallAttemptPolicy.retryDelayMs,
        timeoutMs: registryInstallAttemptPolicy.retryAttemptTimeoutMs,
      });
      await delay(registryInstallAttemptPolicy.retryDelayMs);
    }
  }
  throw new Error("Registry install retry policy exhausted unexpectedly.");
}

export async function runRegistryPhase(
  name,
  action,
  {
    now = () => performance.now(),
    write = (line) => process.stdout.write(line),
  } = {},
) {
  const startedAt = now();
  write(`Registry E2E phase=${name} status=START.\n`);
  try {
    const result = await action();
    const durationMs = Math.max(0, Math.round(now() - startedAt));
    write(`Registry E2E phase=${name} status=PASS durationMs=${durationMs}.\n`);
    return result;
  } catch (error) {
    const durationMs = Math.max(0, Math.round(now() - startedAt));
    write(
      `Registry E2E phase=${name} status=FAIL durationMs=${durationMs} timedOut=${error?.timedOut === true}.\n`,
    );
    throw error;
  }
}

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
