import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NPM_PACKAGE_BOOTSTRAP,
  assertOptionalDependencyManifest,
  fail,
  isRecord,
} from "./npm-package-bootstrap-catalog.mjs";
import { qualifyRegistryHistory } from "./npm-registry-history.ts";
import { readRegistryBytes, observationFailure } from "./npm-registry-read.ts";
import { performance } from "node:perf_hooks";
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
  if (version !== undefined) {
    assertOptionalDependencyManifest(profile, version, true);
  }
  return {
    deprecatedMessage: version?.deprecated ?? null,
    gitHead: version?.gitHead ?? null,
    integrity: version?.dist?.integrity ?? null,
    metadata: {
      "dist-tags": packument["dist-tags"],
      ...await qualifyRegistryHistory(packument, profile, fetchImplementation),
    },
  };
}

export async function liveDependencyVersions(profile, fetchImplementation = fetch, observationOptions) {
  const result = {};
  for (const dependency of [...profile.dependencies, ...(profile.optionalDependencies ?? [])]) {
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

class NpmAuditObservationError extends Error {
  constructor(observation) {
    super("npm bootstrap audit command failed.");
    this.observation = observation;
  }
}

async function runAuditCommand(runNpm, args, root) {
  try {
    return await runNpm(args, root, { timeoutMs: 120_000 });
  } catch (error) {
    throw new NpmAuditObservationError(observationFailure(error, args[0] === "install" ? "install" : "audit"));
  }
}

async function auditLivePackageOnce(profile, temporaryRoot, runNpm) {
  const root = await mkdtemp(join(temporaryRoot ?? tmpdir(), "npm-bootstrap-audit-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "bootstrap-audit", private: true }), "utf8");
    const registry = NPM_PACKAGE_BOOTSTRAP.registry;
    await runAuditCommand(runNpm, [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--fund=false",
      "--save-exact",
      `--registry=${registry}`,
      `--@agent-teams:registry=${registry}`,
      `${profile.name}@${profile.bootstrapVersion}`,
    ], root);
    const { stdout } = await runAuditCommand(runNpm,
      ["audit", "signatures", "--json", "--include-attestations"],
      root,
    );
    return JSON.parse(stdout);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

export const BOOTSTRAP_AVAILABILITY_MILLISECONDS = 180_000;

function assertAvailableBootstrap(profile, bytes) {
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.name !== profile.name || manifest.version !== profile.bootstrapVersion ||
      manifest.dist?.integrity !== profile.approval?.archiveIntegrity) {
    fail("available bootstrap version differs from reviewed authority.");
  }
}

export async function waitForBootstrapAvailability(profile, {
  fetchImplementation = fetch, wait = delay, now = () => performance.now(),
  milliseconds = BOOTSTRAP_AVAILABILITY_MILLISECONDS,
} = {}) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > BOOTSTRAP_AVAILABILITY_MILLISECONDS) {
    fail("bootstrap availability deadline is invalid.");
  }
  const deadline = now() + milliseconds;
  const url = new URL(`${encodeURIComponent(profile.name)}/${profile.bootstrapVersion}`, NPM_PACKAGE_BOOTSTRAP.registry).href;
  let lastObservation = { phase: "availability", code: "NOT_OBSERVED" };
  while (now() < deadline) {
    try {
      const response = await readRegistryBytes(url, fetchImplementation, Math.min(10_000, deadline - now()));
      lastObservation = { phase: "availability", code: `HTTP_${response.status}` };
      if (response.status === 200) {
        assertAvailableBootstrap(profile, response.bytes);
        return;
      }
      if (response.status !== 404 && response.status < 500) {fail(`bootstrap registry availability was refused: ${JSON.stringify(lastObservation)}.`);}
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("npm package bootstrap refused:")) {throw error;}
      lastObservation = observationFailure(error, "availability");
    }
    const remaining = deadline - now();
    if (remaining > 0) {await wait(Math.min(REGISTRY_OBSERVATION_RETRY_MILLISECONDS, remaining));}
  }
  fail(`bootstrap version remained unavailable within its180s observation deadline: ${JSON.stringify(lastObservation)}.`);
}

export async function auditLivePackage(
  profile,
  temporaryRoot,
  { attempts = REGISTRY_OBSERVATION_ATTEMPTS, runNpm = runNpmCommand, wait = delay, availability = waitForBootstrapAvailability } = {},
) {
  await availability(profile);
  let lastObservation;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await auditLivePackageOnce(profile, temporaryRoot, runNpm);
    } catch (error) {
      lastObservation = error instanceof NpmAuditObservationError ? error.observation : observationFailure(error, "audit-json");
    }
    if (attempt + 1 < attempts) {
      await wait(REGISTRY_OBSERVATION_RETRY_MILLISECONDS);
    }
  }
  fail(`npm signature audit remained unknown: ${JSON.stringify(lastObservation)}.`);
}
