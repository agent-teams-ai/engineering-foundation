import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NPM_PACKAGE_BOOTSTRAP,
  fail,
  isRecord,
} from "./npm-package-bootstrap-catalog.mjs";
import { runNpmCommand } from "./pack-test-support.mjs";

export const REGISTRY_OBSERVATION_ATTEMPTS = 6;
export const REGISTRY_OBSERVATION_RETRY_MILLISECONDS = 5_000;

const delay = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

async function fetchWithRetry(
  url,
  fetchImplementation = fetch,
  { attempts = REGISTRY_OBSERVATION_ATTEMPTS, retryNotFound = false, wait = delay } = {},
) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImplementation(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if ((response.status === 404 && !retryNotFound) || response.ok) {
        return response;
      }
      lastError = new Error(`registry returned ${response.status}`);
      if (response.status === 404 && attempt + 1 === attempts) {
        return response;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) {
      await wait(REGISTRY_OBSERVATION_RETRY_MILLISECONDS);
    }
  }
  fail(`registry observation remained unknown${lastError instanceof Error ? `: ${lastError.message}` : "."}`);
}

export async function livePackageEvidence(profile, fetchImplementation = fetch, observationOptions) {
  const packageUrl = new URL(encodeURIComponent(profile.name), NPM_PACKAGE_BOOTSTRAP.registry);
  const response = await fetchWithRetry(packageUrl, fetchImplementation, observationOptions);
  if (response.status === 404) {
    return null;
  }
  let packument;
  try {
    packument = await response.json();
  } catch {
    fail(`${profile.name} registry packument is malformed.`);
  }
  if (!isRecord(packument?.versions) || !isRecord(packument?.["dist-tags"])) {
    fail(`${profile.name} registry packument has an invalid shape.`);
  }
  const version = packument.versions[profile.bootstrapVersion];
  return {
    deprecatedMessage: version?.deprecated ?? null,
    integrity: version?.dist?.integrity ?? null,
    metadata: {
      "dist-tags": packument["dist-tags"],
      versions: Object.keys(packument.versions).toSorted(),
    },
  };
}

export async function liveDependencyVersions(profile, fetchImplementation = fetch, observationOptions) {
  const result = {};
  for (const dependency of profile.dependencies) {
    const packageUrl = new URL(encodeURIComponent(dependency.name), NPM_PACKAGE_BOOTSTRAP.registry);
    const response = await fetchWithRetry(packageUrl, fetchImplementation, observationOptions);
    if (response.status === 404) {
      result[dependency.name] = null;
      continue;
    }
    const packument = await response.json();
    result[dependency.name] = isRecord(packument?.versions) && packument.versions[dependency.version] !== undefined
      ? dependency.version
      : null;
  }
  return result;
}

async function auditLivePackageOnce(profile, temporaryRoot, runNpm) {
  const root = await mkdtemp(join(temporaryRoot ?? tmpdir(), "npm-bootstrap-audit-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "bootstrap-audit", private: true }), "utf8");
    const registry = NPM_PACKAGE_BOOTSTRAP.registry;
    await runNpm([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--fund=false",
      "--save-exact",
      `--registry=${registry}`,
      `--@agent-teams:registry=${registry}`,
      `${profile.name}@${profile.bootstrapVersion}`,
    ], root, { timeoutMs: 120_000 });
    const { stdout } = await runNpm(
      ["audit", "signatures", "--json", "--include-attestations"],
      root,
      { timeoutMs: 120_000 },
    );
    return JSON.parse(stdout);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

export async function auditLivePackage(
  profile,
  temporaryRoot,
  { attempts = REGISTRY_OBSERVATION_ATTEMPTS, runNpm = runNpmCommand, wait = delay } = {},
) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await auditLivePackageOnce(profile, temporaryRoot, runNpm);
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) {
      await wait(REGISTRY_OBSERVATION_RETRY_MILLISECONDS);
    }
  }
  fail(`npm signature audit remained unknown${lastError instanceof Error ? `: ${lastError.message}` : "."}`);
}
