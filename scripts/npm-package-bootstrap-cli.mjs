import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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

async function prepare(args) {
  const profile = bootstrapPackageById(args[0], { approved: true });
  const manifest = JSON.parse(await readFile(profile.manifestPath, "utf8"));
  if (
    manifest.name !== profile.name || manifest.version !== profile.bootstrapVersion || manifest.private === true ||
    manifest.publishConfig?.access !== "public" || manifest.publishConfig.provenance !== true ||
    manifest.publishConfig.registry !== NPM_PACKAGE_BOOTSTRAP.registry
  ) {
    fail("workspace manifest does not match approved public bootstrap authority.");
  }
  for (const dependency of profile.dependencies) {
    if (manifest.dependencies?.[dependency.name] !== "workspace:*") {
      fail(`workspace manifest must use workspace:* for ${dependency.name}.`);
    }
  }
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

export async function prove(
  args,
  assertion,
  absentMessage,
  {
    auditPackage = auditLivePackage,
    liveEvidence = livePackageEvidence,
    writeEvidence = writeFile,
  } = {},
) {
  const profile = bootstrapPackageById(args[0], { approved: true });
  const auditEvidence = await auditPackage(profile);
  const live = await liveEvidence(profile, fetch, { retryNotFound: true });
  if (live === null) {
    fail(absentMessage);
  }
  assertion({
    auditEvidence,
    deprecatedMessage: live.deprecatedMessage,
    expectedCommit: args[2],
    localIntegrity: args[1],
    packageMetadata: live.metadata,
    profile,
    publishedIntegrity: live.integrity,
  });
  await writeEvidence(args[3], `${JSON.stringify({ auditEvidence, live }, null, 2)}\n`, "utf8");
}

async function proveQuarantine(args, assertion, observationOptions) {
  const profile = bootstrapPackageById(args[0], { approved: true });
  const live = await livePackageEvidence(profile, fetch, {
    ...observationOptions,
    retryNotFound: true,
  });
  if (live === null) {
    fail("quarantine target remained absent.");
  }
  assertion({
    deprecatedMessage: live.deprecatedMessage,
    localIntegrity: args[1],
    packageMetadata: live.metadata,
    profile,
    publishedIntegrity: live.integrity,
  });
  await writeFile(args[2], `${JSON.stringify(live, null, 2)}\n`, "utf8");
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
  ),
  "postconditions": (args) => prove(
    args,
    assertBootstrapPostconditions,
    "published bootstrap package remained absent.",
  ),
  prepare,
  "quarantine-postconditions": (args) => proveQuarantine(
    args,
    assertBootstrapQuarantinePostconditions,
  ),
  "quarantine-final-proof": (args) => proveQuarantine(
    args,
    assertBootstrapQuarantineCandidate,
    { attempts: 1 },
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
