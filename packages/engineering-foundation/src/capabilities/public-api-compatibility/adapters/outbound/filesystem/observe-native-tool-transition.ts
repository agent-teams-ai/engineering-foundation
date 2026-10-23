import { createHash } from "node:crypto";
import { lstat, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { inspectCompressedTarArchive, portableEntryIdentity } from "./native-transition-archive.js";
import { migrationBytes, migrationDigest } from "./native-tool-transition-content.js";
import type { PublicApiSourceEvidence } from "../../../application/ports/public-api-evidence.js";
import { stagePackageSnapshot } from "../api-extractor/staged-public-api-input.js";
import { captureNativePublicApiInputs } from "../api-extractor/native-public-api-inputs.js";
import { auditToolchainIdentity } from "../api-extractor/load-pinned-audit-sdk.js";
import { mapReleasedBaseline } from "./public-api-baseline-mapper.js";
import { assertPackageExportCoverage } from "../../../application/policies/validate-package-export-coverage.js";
import { analyzePublicApiCompatibility } from "../../../application/use-cases/analyze-public-api-compatibility.js";
import type { PublicApiConfigurationDependencies } from "../../inbound/configuration/load-capability-config.js";
import type { PublicApiRepository } from "../../../application/ports/public-api-repository.js";
import type {
  PublicApiCompatibilityPolicy,
  PublicApiPackagePolicy,
} from "../../../application/model/public-api.js";
import {
  nativeTransitionError as fail,
  nativeMigrationToolDifference,
  type NativeMigrationPackageInput,
  type NativeMigrationPackageObservation,
  type NativeMigrationObservation,
  type MigrationDigest,
} from "../../../application/model/native-tool-transition.js";
import type { promotePublicApiBaselines } from "../../../application/use-cases/promote-public-api-baselines.js";
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
type PromotionDependencies = Parameters<typeof promotePublicApiBaselines>[1];
function addReleasedArchiveFiles(
  expected: Map<string, Uint8Array>,
  policy: PublicApiPackagePolicy,
  input: NativeMigrationPackageInput,
): number {
  const identities = new Map<string, string>();
  let bytes = 0;
  for (const entry of inspectCompressedTarArchive(Buffer.from(input.archiveBytes), 2657).entries) {
    if (entry.type !== "0" && entry.type !== "5") {
      fail("historical archive has a special member");
    }
    if (!entry.name.startsWith("package/")) {
      fail("historical archive member is outside package/");
    }
    const identity = portableEntryIdentity(entry.name);
    if (identities.has(identity)) {
      fail("historical archive has normalized-colliding members");
    }
    identities.set(identity, entry.type);
    if (entry.type !== "0") {
      continue;
    }
    const path = `${policy.packageRoot}/${entry.name.slice("package/".length)}`;
    if (expected.has(path)) {
      fail("duplicate historical archive member");
    }
    expected.set(path, entry.data);
    bytes += entry.data.byteLength;
  }
  for (const identity of identities.keys()) {
    const parts = identity.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      if (identities.get(parts.slice(0, depth).join("/")) === "0") {
        fail("historical archive file is an ancestor");
      }
    }
  }
  return bytes;
}

function assertArchiveIdentity(
  expected: ReadonlyMap<string, Uint8Array>,
  p: PublicApiPackagePolicy,
  input: NativeMigrationPackageInput,
): void {
  const manifestBytes = expected.get(p.manifestPath);
  if (manifestBytes === undefined) {
    fail("historical archive has no manifest");
  }
  const manifest: unknown = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  const baseline = mapReleasedBaseline(
    JSON.parse(Buffer.from(input.baselineBytes).toString("utf8")),
    p,
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("name" in manifest) ||
    !("version" in manifest) ||
    manifest.name !== p.packageName ||
    manifest.version !== baseline.packageVersion
  ) {
    fail("historical archive package/version differs from original baseline");
  }
  assertPackageExportCoverage({ manifest, policy: p });
}

/** The host authenticates archive origins and excludes writers for the entire
 * released namespace and installed declaration closure. These checks bind bytes;
 * they do not authenticate a producer or sandbox a hostile same-user writer. */
async function assertReleasedNamespace(
  root: string,
  policy: PublicApiCompatibilityPolicy,
  inputs: readonly NativeMigrationPackageInput[],
  configurationFiles: readonly { readonly path: string; readonly bytes: Uint8Array }[],
  evidence: PublicApiSourceEvidence,
): Promise<void> {
  const expected = new Map<string, Uint8Array>();
  let bytes = 0;
  let compressedBytes = 0;
  for (const p of policy.packages) {
    const input = inputs.find((row) => row.packageName === p.packageName)!;
    compressedBytes += input.archiveBytes.byteLength;
    if (
      compressedBytes > 32 * 1024 * 1024 ||
      input.baselineBytes.byteLength > 32 * 1024 * 1024 ||
      input.configBytes.byteLength > 32 * 1024 * 1024
    ) {
      fail("historical packet byte budget exceeded");
    }
    bytes += addReleasedArchiveFiles(expected, p, input);
    if (expected.has(p.tsconfigPath)) {
      fail("historical archive unexpectedly includes build configuration");
    }
    expected.set(p.tsconfigPath, input.configBytes);
    bytes += input.configBytes.byteLength;
    assertArchiveIdentity(expected, p, input);
  }
  for (const file of configurationFiles) {
    if (
      expected.has(file.path) ||
      !/\.jsonc?$/u.test(file.path) ||
      file.path.includes("\\") ||
      file.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      file.path.startsWith("/")
    ) {
      fail("extra configuration is not a unique contained JSON input");
    }
    expected.set(file.path, file.bytes);
    bytes += file.bytes.byteLength;
  }
  if (bytes > 128 * 1024 * 1024 || expected.size > 20_000) {
    fail("historical input budget exceeded");
  }
  const found = new Set<string>();
  let count = 0;
  async function dependencies(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 50_000) {
        fail("historical dependency directory budget exceeded");
      }
      // Package-manager command links are neither declarations nor resolution inputs.
      if (entry.name === ".bin") {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        fail("historical dependencies must be frozen ordinary data, never candidate links");
      }
      if (entry.isDirectory()) {
        await dependencies(path);
      }
    }
  }
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 50_000) {
        fail("historical directory budget exceeded");
      }
      if (entry.name === "node_modules") {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          fail("historical dependency root must be an ordinary directory");
        }
        await dependencies(join(directory, entry.name));
        continue;
      }
      const file = join(directory, entry.name);
      const path = relative(root, file).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await visit(file);
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        fail(`historical namespace contains a special member: ${path}`);
      }
      const original = expected.get(path);
      if (
        original === undefined ||
        !Buffer.from(original).equals(
          await evidence.files.read({ root, candidate: file, maxBytes: original.byteLength }),
        )
      ) {
        fail(`historical namespace differs from archive/config data: ${path}`);
      }
      found.add(path);
    }
  }
  if (!(await lstat(root)).isDirectory()) {
    fail("historical root is not a directory");
  }
  await visit(root);
  if (found.size !== expected.size) {
    fail("historical archive/config member is missing");
  }
}

async function releasedInputDigest(
  root: string,
  policy: PublicApiPackagePolicy,
  evidence: PublicApiSourceEvidence,
  signal?: AbortSignal,
): Promise<MigrationDigest> {
  const staged = await stagePackageSnapshot({ root, policy }, evidence);
  try {
    const files = await captureNativePublicApiInputs({
      stagingRoot: staged.stagingRoot,
      packageRoot: staged.packageRoot,
      ...(signal === undefined ? {} : { signal }),
    });
    const inventory = [...files]
      .map(([path, text]) => ({
        path: relative(staged.stagingRoot, path).replaceAll("\\", "/"),
        digest: migrationDigest(Buffer.from(text)),
      }))
      .toSorted((a, b) => order(a.path, b.path));
    if (inventory.some((row) => row.path.startsWith("../"))) {
      fail("native input capture escaped its virtual namespace");
    }
    return migrationDigest(migrationBytes(inventory));
  } finally {
    await rm(staged.stagingRoot, { recursive: true, force: true });
  }
}

export async function observeNativeMigration(
  options: {
    readonly consumerRoot: string;
    readonly releasedRoot: string;
    readonly policy: PublicApiCompatibilityPolicy;
    readonly packages: readonly NativeMigrationPackageInput[];
    readonly configurationFiles?: readonly { readonly path: string; readonly bytes: Uint8Array }[];
    readonly signal?: AbortSignal;
  },
  dependencies: {
    readonly typed: PromotionDependencies;
    readonly artifacts: () => Promise<PromotionDependencies>;
    readonly evidence: PublicApiSourceEvidence;
    readonly assertSchema: PublicApiConfigurationDependencies["assertSchema"];
  },
): Promise<NativeMigrationObservation> {
  const input = {
    consumerRoot: options.consumerRoot,
    releasedRoot: options.releasedRoot,
    policy: structuredClone(options.policy),
    packages: structuredClone(options.packages),
    configurationFiles: structuredClone(options.configurationFiles ?? []),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const names = input.policy.packages.map((p) => p.packageName).toSorted();
  if (
    names.length === 0 ||
    new Set(names).size !== names.length ||
    JSON.stringify(input.packages.map((p) => p.packageName).toSorted()) !== JSON.stringify(names)
  ) {
    fail("complete unique governed package inventory is required");
  }
  if (resolve(input.consumerRoot) === resolve(input.releasedRoot)) {
    fail("candidate cannot be the historical observation root");
  }
  await assertReleasedNamespace(
    input.releasedRoot,
    input.policy,
    input.packages,
    input.configurationFiles,
    dependencies.evidence,
  );
  const typed = dependencies.typed;
  const packages: NativeMigrationPackageObservation[] = [];
  for (const p of input.policy.packages) {
    const source = input.packages.find((row) => row.packageName === p.packageName)!;
    const parsed: unknown = JSON.parse(Buffer.from(source.baselineBytes).toString("utf8"));
    await dependencies.assertSchema(
      "package-public-api-baseline/v1",
      parsed,
      "public-api-native-migration",
    );
    const baseline = mapReleasedBaseline(parsed, p);
    const closure = await releasedInputDigest(
      input.releasedRoot,
      p,
      dependencies.evidence,
      input.signal,
    );
    const nativeReleased = await typed.extractor.extract(
      input.releasedRoot,
      p,
      baseline.packageVersion,
      input.signal,
    );
    const evidence = await typed.repository.readReleaseEvidence(
      input.consumerRoot,
      input.policy.changesetDirectory,
      p,
      input.signal,
    );
    const nativeCandidate = await typed.extractor.extract(
      input.consumerRoot,
      p,
      evidence.packageVersion,
      input.signal,
    );
    packages.push({
      packageName: p.packageName,
      baselineDigest: migrationDigest(source.baselineBytes),
      archiveDigest: migrationDigest(source.archiveBytes),
      archiveIntegrity: `sha512-${createHash("sha512").update(source.archiveBytes).digest("base64")}`,
      configDigest: migrationDigest(source.configBytes),
      releasedInputsDigest: closure,
      nativeReleasedDigest: migrationDigest(migrationBytes(nativeReleased)),
      baseline,
      nativeReleased,
      nativeCandidate,
    });
  }
  await assertReleasedNamespace(
    input.releasedRoot,
    input.policy,
    input.packages,
    input.configurationFiles,
    dependencies.evidence,
  );
  const repository: PublicApiRepository = {
    readReleasedBaseline: async (_root, p) =>
      packages.find((row) => row.packageName === p.packageName)!.nativeReleased,
    readReleaseEvidence: typed.repository.readReleaseEvidence.bind(typed.repository),
    describeReleasedBaselineWrite: typed.repository.describeReleasedBaselineWrite.bind(
      typed.repository,
    ),
    writeReleasedBaseline: async () => fail("observation cannot write a baseline"),
  };
  const extractor = {
    extract: async (_root: string, p: PublicApiPackagePolicy) =>
      packages.find((row) => row.packageName === p.packageName)!.nativeCandidate,
  };
  const typedDiagnostics = await analyzePublicApiCompatibility(input, {
    ...typed,
    repository,
    extractor,
  });
  const artifacts = await dependencies.artifacts();
  const artifactDiagnostics = await analyzePublicApiCompatibility(input, artifacts);
  const toolDiff = nativeMigrationToolDifference(packages);
  return {
    kind: "foundation:public-api-native-migration:observation:1",
    policyDigest: migrationDigest(migrationBytes(input.policy)),
    toolchainIdentity: auditToolchainIdentity(),
    packages,
    toolDiff,
    toolDiffDigest: migrationDigest(migrationBytes(toolDiff)),
    typedDiagnostics,
    artifactDiagnostics,
  };
}
