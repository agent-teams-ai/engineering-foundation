export { assertPhysicalPublishablePackageRoots } from "./pack-manifest-policy.ts";
import {
  assertPhysicalPublishablePackageRoots,
  readBoundedManifest,
  manifestReleaseTargets,
  pathIdentity,
  containsPath,
  validateRequiredArtifactPaths,
} from "./pack-manifest-policy.ts";
import { deriveBuildClosures } from "./pack-build-closures.ts";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packAndInspectArtifact, snapshotVerifiedArtifact } from "./pack-artifact-e2e.mjs";
import {
  PUBLISHABLE_PACKAGES,
  PUBLISHABLE_PACKAGE_DEPENDENCY_DECLARATIONS,
  PUBLISHABLE_PACKAGE_CATALOG,
  derivePublishablePackageProjection,
} from "./publishable-packages.mjs";
import { createPnpmRunner } from "./pack-test-support.mjs";
import { runStagedPackageBuild } from "./pack-artifact-stage-support.mjs";
import { prepareMarkdownPublication } from "./markdown-publication.mjs";
import {
  assertPhysicalPath,
  capturePackageArtifactInputs,
  retainArchiveCustody,
  verifyArchiveCustody,
} from "./package-artifact-custody.mts";
import { mapIndependentPackageTargets } from "./package-qualification-groups.mts";

const qualifiedProductions = new WeakMap();
const invocations = new WeakMap();

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;
const PORTABLE_ARTIFACT_PATH =
  /^(?!\/)(?!.*\\)(?!.*\/\/)(?!.*\/$)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@/-]+$/u;

function fail(message) {
  throw new Error(`Publishable artifact staging is invalid: ${message}`);
}

function validateProjectedPackages(repositoryRoot, packages) {
  if (typeof repositoryRoot !== "string" || !isAbsolute(repositoryRoot)) {
    fail("repositoryRoot must be an absolute path");
  }
  if (!Array.isArray(packages) || packages.length === 0) {
    fail("packages must be a non-empty manifest-derived projection");
  }
  const byName = new Map();
  const stageRoots = [];
  for (const entry of packages) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.name !== "string" ||
      !PACKAGE_NAME.test(entry.name)
    ) {
      fail("each projected package must have an identity");
    }
    if (byName.has(entry.name)) {
      fail(`duplicate package identity ${entry.name}`);
    }
    if (
      typeof entry.root !== "string" ||
      !PORTABLE_ARTIFACT_PATH.test(entry.root) ||
      isAbsolute(entry.root)
    ) {
      fail(`${entry.name} has an unsafe package root`);
    }
    const absoluteRoot = resolve(repositoryRoot, entry.root);
    if (!containsPath(repositoryRoot, absoluteRoot) || absoluteRoot === repositoryRoot) {
      fail(`${entry.name} package root escapes the repository`);
    }
    const identity = pathIdentity(entry.root);
    for (const { identity: otherIdentity, name } of stageRoots) {
      const nested =
        identity === otherIdentity ||
        identity.startsWith(`${otherIdentity}/`) ||
        otherIdentity.startsWith(`${identity}/`);
      if (nested) {
        fail(`${entry.name} and ${name} have colliding stage paths`);
      }
    }
    stageRoots.push({ identity, name: entry.name });
    byName.set(entry.name, entry);
  }
  return byName;
}

// Pure planning seam for synthetic manifest-projection tests. Production orchestration below
// deliberately supplies the authoritative projection and the real artifact packer itself.
export function derivePublishableArtifactPlan({
  dependencyDeclarations,
  packages,
  repositoryRoot,
  requiredArtifactPaths,
}) {
  const byName = validateProjectedPackages(repositoryRoot, packages);
  validateRequiredArtifactPaths(requiredArtifactPaths, new Set(byName.keys()));
  const closures = deriveBuildClosures(packages, dependencyDeclarations, byName);
  return Object.freeze(
    packages.map((entry) =>
      Object.freeze({
        buildPackageNames: closures.get(entry.name),
        package: entry,
        requiredArtifactPaths: Object.freeze([...requiredArtifactPaths[entry.name]]),
        stagePackages: Object.freeze(
          closures.get(entry.name).map((name) => Object.freeze({ ...byName.get(name) })),
        ),
      }),
    ),
  );
}

async function loadManifestPolicy(repositoryRoot, entry) {
  const manifest = await readBoundedManifest(
    resolve(repositoryRoot, entry.manifestPath),
    entry.manifestPath,
  );
  if (
    manifest.name !== entry.name ||
    typeof manifest.version !== "string" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)
  ) {
    fail(`${entry.manifestPath} has an unexpected package identity or version`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail(`${entry.manifestPath} must own a non-empty package files allowlist`);
  }
  if (typeof manifest.scripts?.build !== "string" || manifest.scripts.build.trim() === "") {
    fail(`${entry.manifestPath} must own a package build contract`);
  }
  const allowed = [];
  const required = manifestReleaseTargets(manifest);
  for (const path of manifest.files) {
    if (typeof path !== "string" || !PORTABLE_ARTIFACT_PATH.test(path)) {
      fail(`${entry.manifestPath} contains an unsafe package files path`);
    }
    if (path !== "dist" && (await isRequiredManifestFile(repositoryRoot, entry, path))) {
      required.add(path);
    }
    allowed.push(path);
  }
  return { allowed, manifest, required };
}

async function isRequiredManifestFile(repositoryRoot, entry, path) {
  try {
    const metadata = await lstat(resolve(repositoryRoot, entry.root, path));
    if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
      fail(`${entry.manifestPath} package files path must be a regular file or directory`);
    }
    return metadata.isFile() && !["README.md", "CHANGELOG.md", "LICENSE"].includes(path);
  } catch (error) {
    if (error?.code === "ENOENT" && path === "LICENSE") {
      return false;
    }
    throw error;
  }
}

async function loadPublishableManifestPolicies(repositoryRoot) {
  const manifests = new Map();
  const requiredArtifactPaths = {};
  const allowedArtifactPaths = {};
  const manifestFilePolicies = {};
  for (const entry of PUBLISHABLE_PACKAGES) {
    const { allowed, manifest, required } = await loadManifestPolicy(repositoryRoot, entry);
    manifests.set(entry.name, Object.freeze(structuredClone(manifest)));
    allowedArtifactPaths[entry.name] = [...new Set(allowed)].toSorted();
    requiredArtifactPaths[entry.name] = [...required].toSorted();
    manifestFilePolicies[entry.name] = [...new Set(manifest.files)].toSorted();
  }
  return { allowedArtifactPaths, manifestFilePolicies, manifests, requiredArtifactPaths };
}

function assertRequiredPathsAllowed(plan, manifestFilePolicies) {
  for (const item of plan) {
    for (const requiredPath of item.requiredArtifactPaths) {
      if (
        !manifestFilePolicies[item.package.name].some(
          (allowed) => requiredPath === allowed || requiredPath.startsWith(`${allowed}/`),
        )
      ) {
        fail(
          `required artifact ${requiredPath} for ${item.package.name} is outside its manifest files allowlist`,
        );
      }
    }
  }
}

export async function packPublishableArtifacts(input) {
  if (input === null || typeof input !== "object") {
    fail("input must be an object");
  }
  const inputKeys = Object.keys(input);
  const acceptedKeys = new Set(["temporaryRoot"]);
  if (inputKeys.some((key) => !acceptedKeys.has(key))) {
    fail(
      `production orchestration does not accept ${inputKeys.find((key) => !acceptedKeys.has(key))} overrides`,
    );
  }
  if (typeof input.temporaryRoot !== "string" || !isAbsolute(input.temporaryRoot)) {
    fail("temporaryRoot must be an absolute path");
  }
  await mkdir(input.temporaryRoot, { recursive: true });
  const temporaryRoot = await realpath(input.temporaryRoot);
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const { allowedArtifactPaths, manifestFilePolicies, manifests, requiredArtifactPaths } =
    await loadPublishableManifestPolicies(repositoryRoot);
  const projection = derivePublishablePackageProjection({
    catalog: PUBLISHABLE_PACKAGE_CATALOG,
    manifestsByName: manifests,
  });
  if (
    JSON.stringify(projection.packages) !== JSON.stringify(PUBLISHABLE_PACKAGES) ||
    JSON.stringify(projection.declarations) !==
      JSON.stringify(PUBLISHABLE_PACKAGE_DEPENDENCY_DECLARATIONS)
  ) {
    fail("manifest-derived package projection changed since script loading");
  }
  const additionalPaths = [];
  if (
    PUBLISHABLE_PACKAGES.some((entry) => entry.name === "@agent-teams/docs-protocol-agent-teams")
  ) {
    const { runtimePolicyBuildInputPaths } =
      await import("../packages/docs-protocol-agent-teams/scripts/runtime-policy-input-paths.mjs");
    additionalPaths.push(...runtimePolicyBuildInputPaths);
  }
  const inputIdentity = await capturePackageArtifactInputs(
    repositoryRoot,
    PUBLISHABLE_PACKAGES,
    PUBLISHABLE_PACKAGE_DEPENDENCY_DECLARATIONS,
    additionalPaths,
  );
  const plan = derivePublishableArtifactPlan({
    dependencyDeclarations: PUBLISHABLE_PACKAGE_DEPENDENCY_DECLARATIONS,
    packages: PUBLISHABLE_PACKAGES,
    repositoryRoot,
    requiredArtifactPaths,
  });
  assertRequiredPathsAllowed(plan, manifestFilePolicies);
  await assertPhysicalPublishablePackageRoots(repositoryRoot, PUBLISHABLE_PACKAGES);
  const authoritativePackageRoots = PUBLISHABLE_PACKAGES.map((entry) =>
    resolve(repositoryRoot, entry.root),
  );
  const runPnpm = createPnpmRunner();
  const manager = await readBoundedManifest(
    join(repositoryRoot, "package.json"),
    "Repository manifest",
  );
  const observedPnpm = (await runPnpm(["--version"], repositoryRoot)).stdout.trim();
  if (manager.packageManager !== `pnpm@${observedPnpm}`) {
    fail("actual pnpm differs from the pinned toolchain");
  }
  const runBuild = async (stagedPackageRoot, { packageName, stageRoot }) => {
    process.stderr.write(`Qualified artifact build: ${packageName}; stage=${stageRoot}\n`);
    await runStagedPackageBuild(runPnpm, stagedPackageRoot);
  };
  const markdownPublication = PUBLISHABLE_PACKAGES.some(
    (entry) => entry.name === "@agent-teams/document-authoring",
  )
    ? await prepareMarkdownPublication(repositoryRoot)
    : undefined;
  const pending = await mapIndependentPackageTargets(plan, async (item) => {
    const entry = item.package;
    const artifact = await packAndInspectArtifact({
      artifactLabel: `package-${Buffer.from(entry.name, "utf8").toString("hex")}`,
      allowedArtifactPaths: allowedArtifactPaths[entry.name],
      authoritativePackageRoots,
      buildPackageNames: item.buildPackageNames,
      dependencyDeclarations: PUBLISHABLE_PACKAGE_DEPENDENCY_DECLARATIONS,
      packageName: entry.name,
      markdownPublication,
      packageRoot: resolve(repositoryRoot, entry.root),
      repositoryRoot,
      requiredArtifactPaths: item.requiredArtifactPaths,
      runBuild,
      runPnpm,
      stagePackages: item.stagePackages.map((support) =>
        Object.freeze({
          ...support,
          ...manifests.get(support.name),
          sourceRoot: resolve(repositoryRoot, support.root),
        }),
      ),
      temporaryRoot,
    });
    return { artifact, entry, item };
  });
  // Every production process has settled. Use the producer's retained verified
  // bytes: later builds may mutate original staging paths without changing these
  // snapshots. Downstream snapshots acquire separate physical custody below;
  // they must never be silently repaired from the retained bytes after tampering.
  const finalRoot = await mkdtemp(join(temporaryRoot, "qualified-package-artifacts-"));
  const records = {};
  for (const { artifact, entry, item } of pending) {
    const bytes = snapshotVerifiedArtifact(artifact);
    const packageRoot = join(finalRoot, Buffer.from(entry.name, "utf8").toString("hex"));
    await mkdir(packageRoot, { recursive: false });
    const archivePath = join(packageRoot, artifact.archiveName);
    await writeFile(archivePath, bytes, { flag: "wx", mode: 0o444 });
    records[entry.name] = Object.freeze({
      archiveFileSpecifier: `file:${archivePath.replaceAll("\\", "/")}`,
      archiveName: artifact.archiveName,
      archivePath,
      buildSupportPackageNames: item.buildPackageNames,
      packageName: entry.name,
      packageVersion: manifests.get(entry.name).version,
      requiredArtifactPaths: item.requiredArtifactPaths,
      sha256: artifact.sha256,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    });
  }
  Object.freeze(records);
  const custody = await retainArchiveCustody(finalRoot, records);
  qualifiedProductions.set(records, { custody, repositoryRoot, inputIdentity, additionalPaths });
  await assertQualifiedPackageArtifacts(records);
  return records;
}

function qualifiedProduction(records) {
  const production = qualifiedProductions.get(records);
  if (production === undefined) {
    fail("records are not an original process-local qualified production");
  }
  if (
    Object.keys(records).join("\0") !== PUBLISHABLE_PACKAGES.map((entry) => entry.name).join("\0")
  ) {
    fail("qualified package membership changed");
  }
  return production;
}

async function assertQualifiedArtifactCustody(records) {
  await verifyArchiveCustody(qualifiedProduction(records).custody, records);
}

export async function assertQualifiedPackageArtifacts(records) {
  const production = qualifiedProduction(records);
  const current = await capturePackageArtifactInputs(
    production.repositoryRoot,
    PUBLISHABLE_PACKAGES,
    PUBLISHABLE_PACKAGE_DEPENDENCY_DECLARATIONS,
    production.additionalPaths,
  );
  if (current !== production.inputIdentity) {
    fail("qualification inputs or runtime/toolchain changed");
  }
  await verifyArchiveCustody(production.custody, records);
}

// Closed local lifetimes; there is no serialized carrier or path-based reuse.
/**
 * @param {import("./package-artifact-custody.mts").QualificationMode} mode
 * @param {(handle: import("./package-artifact-custody.mts").QualificationHandle) => unknown | Promise<unknown>} action
 * @returns {Promise<import("./package-artifact-custody.mts").QualificationEvidence>}
 */
export async function withQualifiedPackageArtifacts(mode, action) {
  const stageModes = {
    combined: ["packed", "registry"],
    packed: ["packed"],
    registry: ["registry"],
  };
  const stages = Object.hasOwn(stageModes, mode) ? stageModes[mode] : undefined;
  if (stages === undefined || typeof action !== "function") {
    fail("unknown qualification invocation");
  }
  const parent = await realpath(tmpdir());
  const temporaryRoot = await mkdtemp(join(parent, "ef-qualified-"));
  const identity = await assertPhysicalPath(temporaryRoot, true);
  const handle = Object.freeze(Object.create(null));
  const state = {
    temporaryRoot,
    stages,
    next: 0,
    accepting: true,
    closed: false,
    pending: undefined,
    failed: false,
    failure: undefined,
  };
  invocations.set(handle, state);
  const errors = [];
  let evidence;
  try {
    state.records = await packPublishableArtifacts({ temporaryRoot });
    await action(handle);
    state.accepting = false;
    if (state.pending !== undefined) {
      await state.pending;
    }
    if (state.failed) {
      throw state.failure;
    }
    if (state.next !== stages.length) {
      fail("invocation did not complete every required consumer stage");
    }
    await assertQualifiedPackageArtifacts(state.records);
    evidence = Object.freeze(
      Object.values(state.records).map((record) =>
        Object.freeze({
          name: record.packageName,
          version: record.packageVersion,
          sha256: record.sha256,
          integrity: record.integrity,
        }),
      ),
    );
  } catch (error) {
    errors.push(error);
  } finally {
    // Close admission before draining; accepted work can still finish its checks.
    state.accepting = false;
    // Drain an admitted stage even when its caller returns or rejects early.
    if (state.pending !== undefined) {
      try {
        await state.pending;
      } catch (error) {
        if (!errors.includes(error)) {
          errors.push(error);
        }
      }
    }
    state.closed = true;
    if (state.records !== undefined) {
      qualifiedProductions.delete(state.records);
    }
    const keep =
      mode !== "combined" &&
      process.env[
        mode === "packed"
          ? "AGENT_TEAMS_KEEP_PACK_TEST_ARTIFACTS"
          : "AGENT_TEAMS_KEEP_REGISTRY_E2E_ARTIFACTS"
      ] === "1";
    try {
      const current = await assertPhysicalPath(temporaryRoot, true);
      if (current.dev !== identity.dev || current.ino !== identity.ino) {
        fail("invocation root was replaced before cleanup");
      }
      if (keep) {
        process.stderr.write(`Closed qualification debug artifacts: ${temporaryRoot}\n`);
      } else {
        await rm(temporaryRoot, { recursive: true, force: false });
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Package qualification and/or cleanup failed");
  }
  return evidence;
}

/**
 * @param {object | undefined} handle
 * @param {import("./package-artifact-custody.mts").QualificationStage} stage
 * @param {(context: import("./package-artifact-custody.mts").QualificationContext) => unknown | Promise<unknown>} action
 * @returns {Promise<unknown>}
 */
export function runQualifiedArtifactConsumer(handle, stage, action) {
  const state = invocations.get(handle);
  if (
    state === undefined ||
    !state.accepting ||
    state.closed ||
    state.failed ||
    state.pending !== undefined ||
    stage !== state.stages[state.next] ||
    typeof action !== "function"
  ) {
    return Promise.reject(
      new Error("Qualified artifact invocation is forged, closed, failed or out of sequence"),
    );
  }
  const checkpoint = async () => {
    if (state.closed || state.failed) {
      fail("consumer invocation is closed or failed");
    }
    await assertQualifiedArtifactCustody(state.records);
  };
  // Fresh source/toolchain identity brackets each complete consumer stage. Inner
  // checkpoints preserve archive custody without repeating the whole source walk.
  const stageCheckpoint = async () => {
    if (state.closed || state.failed) {
      fail("consumer invocation is closed or failed");
    }
    await assertQualifiedPackageArtifacts(state.records);
  };
  const pending = (async () => {
    try {
      await stageCheckpoint();
      const result = await action({
        artifacts: state.records,
        temporaryRoot: state.temporaryRoot,
        checkpoint,
      });
      await stageCheckpoint();
      state.next += 1;
      return result;
    } catch (error) {
      state.failed = true;
      state.failure = error;
      throw error;
    } finally {
      state.pending = undefined;
    }
  })();
  state.pending = pending;
  // Observe rejection immediately; the lifetime owner still propagates it.
  void pending.catch(() => {});
  return pending;
}
