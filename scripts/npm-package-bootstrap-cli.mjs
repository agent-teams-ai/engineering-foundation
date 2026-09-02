import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  NPM_PACKAGE_BOOTSTRAP,
  assertBootstrapMutationPreconditions,
  assertBootstrapPostconditions,
  assertBootstrapQuarantineCandidate,
  assertBootstrapQuarantinePostconditions,
  assertOneDayGranularTokenWindow,
  assertReusableBootstrap,
  auditLivePackage,
  bootstrapPackageById,
  livePackageEvidence,
  observeRegistryPreflight,
  validatePackEvidence,
  verifyLiveBootstrapBaselines,
  verifyReleaseBootstrapBaselines,
} from "./npm-package-bootstrap.mjs";
import { fail } from "./npm-package-bootstrap-catalog.mjs";
import {
  REGISTRY_OBSERVATION_ATTEMPTS,
  REGISTRY_OBSERVATION_RETRY_MILLISECONDS,
} from "./npm-package-bootstrap-registry.mjs";

async function output(path, values) {
  await appendFile(
    path,
    Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""),
    "utf8",
  );
}

async function tokenWindow(args) {
  assertOneDayGranularTokenWindow({ createdAt: args[0], expiresAt: args[1], now: args[2] });
}

export function assertWorkspaceManifestMatchesProfile(profile, manifest) {
  if (
    manifest.name !== profile.name || manifest.version !== profile.bootstrapVersion || manifest.private === true ||
    manifest.publishConfig?.access !== "public" || manifest.publishConfig.provenance !== true ||
    manifest.publishConfig.registry !== NPM_PACKAGE_BOOTSTRAP.registry
  ) {
    fail("workspace manifest does not match approved public bootstrap authority.");
  }
  const dependencyNames = Object.keys(manifest.dependencies ?? {}).toSorted();
  const expectedNames = profile.dependencies.map(({ name }) => name).toSorted();
  if (JSON.stringify(dependencyNames) !== JSON.stringify(expectedNames)) {
    fail("workspace manifest runtime dependency names differ from bootstrap authority.");
  }
  for (const dependency of profile.dependencies) {
    if (manifest.dependencies[dependency.name] !== dependency.specifier) {
      fail(`workspace manifest dependency specifier mismatch for ${dependency.name}.`);
    }
  }
}

async function prepare(args) {
  const profile = bootstrapPackageById(args[0], { approved: true });
  const manifest = JSON.parse(await readFile(profile.manifestPath, "utf8"));
  assertWorkspaceManifestMatchesProfile(profile, manifest);
  await output(args[1], {
    deprecationMessage: profile.deprecationMessage,
    name: profile.name,
    root: profile.root,
    tag: `${profile.name}@${profile.bootstrapVersion}`,
    title: `${profile.name} ${profile.bootstrapVersion} bootstrap`,
    version: profile.bootstrapVersion,
  });
}

async function packEvidence(args) {
  const profile = bootstrapPackageById(args[0], { approved: true });
  const evidence = validatePackEvidence({
    archivePath: resolve(args[4]),
    archiveBytes: await readFile(args[4]),
    packageTree: args[6],
    packedManifest: JSON.parse(await readFile(args[2], "utf8")),
    packReport: JSON.parse(await readFile(args[1], "utf8")),
    profile,
    tarEntries: (await readFile(args[3], "utf8")).trim().split("\n"),
    tarVerboseListing: await readFile(args[7], "utf8"),
  });
  await output(args[5], evidence);
}

async function registryPreflight(args, observationOptions) {
  const profile = bootstrapPackageById(args[0], { approved: true });
  const action = await observeRegistryPreflight(profile, args[1], { observationOptions });
  await output(args[2], { action });
}

function verifiedEvidence({ deprecationMatches, distTags, expectedCommit, localIntegrity, profile }) {
  const evidence = {
    schemaVersion: 2,
    verified: true,
    package: {
      integrity: localIntegrity,
      name: profile.name,
      version: profile.bootstrapVersion,
    },
    live: {
      deprecationMatches,
      distTags: Object.fromEntries(Object.keys(distTags).toSorted().map((tag) => [tag, distTags[tag]])),
    },
  };
  if (expectedCommit !== undefined) {
    evidence.provenance = {
      commit: expectedCommit,
      ref: profile.provenance.ref,
      repository: NPM_PACKAGE_BOOTSTRAP.repository,
      workflow: profile.provenance.workflowPath,
    };
  }
  return evidence;
}

async function observeAssertion({ attempts, observe, wait }) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await observe();
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) {
      await wait(REGISTRY_OBSERVATION_RETRY_MILLISECONDS);
    }
  }
  throw lastError;
}

export async function prove(
  args,
  assertion,
  absentMessage,
  {
    assertionAttempts = 1,
    auditPackage = auditLivePackage,
    liveEvidence = livePackageEvidence,
    wait = delay,
    writeEvidence = writeFile,
  } = {},
) {
  const profile = bootstrapPackageById(args[0], { approved: true });
  const auditEvidence = await auditPackage(profile);
  const live = await observeAssertion({
    attempts: assertionAttempts,
    observe: async () => {
      const evidence = await liveEvidence(profile, fetch, {
        attempts: assertionAttempts > 1 ? 1 : undefined,
        retryNotFound: true,
      });
      if (evidence === null) {
        fail(absentMessage);
      }
      assertion({
        auditEvidence,
        deprecatedMessage: evidence.deprecatedMessage,
        expectedCommit: args[2],
        localIntegrity: args[1],
        packageMetadata: evidence.metadata,
        profile,
        publishedIntegrity: evidence.integrity,
      });
      return evidence;
    },
    wait,
  });
  const evidence = verifiedEvidence({
    deprecationMatches: live.deprecatedMessage === profile.deprecationMessage,
    distTags: live.metadata["dist-tags"],
    expectedCommit: args[2],
    localIntegrity: args[1],
    profile,
  });
  await writeEvidence(args[3], `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

export async function proveQuarantine(
  args,
  assertion,
  {
    assertionAttempts = 1,
    liveEvidence = livePackageEvidence,
    observationOptions,
    wait = delay,
    writeEvidence = writeFile,
  } = {},
) {
  const profile = bootstrapPackageById(args[0], { approved: true });
  const live = await observeAssertion({
    attempts: assertionAttempts,
    observe: async () => {
      const evidence = await liveEvidence(profile, fetch, {
        ...observationOptions,
        attempts: assertionAttempts > 1 ? 1 : observationOptions?.attempts,
        retryNotFound: true,
      });
      if (evidence === null) {
        fail("quarantine target remained absent.");
      }
      assertion({
        deprecatedMessage: evidence.deprecatedMessage,
        localIntegrity: args[1],
        packageMetadata: evidence.metadata,
        profile,
        publishedIntegrity: evidence.integrity,
      });
      return evidence;
    },
    wait,
  });
  const evidence = verifiedEvidence({
    deprecationMatches: live.deprecatedMessage === profile.deprecationMessage,
    distTags: live.metadata["dist-tags"],
    localIntegrity: args[1],
    profile,
  });
  await writeEvidence(args[2], `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

const handlers = Object.freeze({
  "check-live": async () => {
    const verified = await verifyLiveBootstrapBaselines();
    process.stdout.write(`Verified npm bootstrap baselines: ${verified.join(", ") || "none required"}.\n`);
  },
  "check-release": async () => {
    const verified = await verifyReleaseBootstrapBaselines();
    process.stdout.write(`Verified required npm bootstrap baselines: ${verified.join(", ")}.\n`);
  },
  "pack-evidence": packEvidence,
  "mutation-proof": (args) => prove(
    args,
    assertBootstrapMutationPreconditions,
    "bootstrap mutation target remained absent.",
    { assertionAttempts: REGISTRY_OBSERVATION_ATTEMPTS },
  ),
  "postconditions": (args) => prove(
    args,
    assertBootstrapPostconditions,
    "published bootstrap package remained absent.",
    { assertionAttempts: REGISTRY_OBSERVATION_ATTEMPTS },
  ),
  prepare,
  "quarantine-postconditions": (args) => proveQuarantine(
    args,
    assertBootstrapQuarantinePostconditions,
    { assertionAttempts: REGISTRY_OBSERVATION_ATTEMPTS },
  ),
  "quarantine-final-proof": (args) => proveQuarantine(
    args,
    assertBootstrapQuarantineCandidate,
    { observationOptions: { attempts: 1 } },
  ),
  "quarantine-proof": (args) => proveQuarantine(
    args,
    assertBootstrapQuarantineCandidate,
  ),
  "registry-preflight": registryPreflight,
  "registry-final-preflight": (args) => registryPreflight(args, { attempts: 1 }),
  "reuse-proof": (args) => prove(
    args,
    assertReusableBootstrap,
    "reused bootstrap package became absent.",
  ),
  "token-window": tokenWindow,
});

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  const handler = handlers[command];
  if (handler === undefined) {
    fail("unknown command.");
  }
  await handler(args);
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  await main();
}
