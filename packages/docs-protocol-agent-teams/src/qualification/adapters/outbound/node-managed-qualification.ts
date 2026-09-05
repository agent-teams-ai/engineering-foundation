import { constants } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";

import {
  docsCheckV2,
  docsDoctorV2,
  docsFindV2,
  docsInfoV2,
  docsNewV2,
  docsRecoverV2
} from "@agent-teams/docs-protocol";
import {
  applyReachability,
  bootstrapQualificationInstallation,
  fileSnapshot,
  isQualificationEvidenceExcludedPath,
  portableQualificationSkill,
  readContainedBoundedFile,
  snapshot,
  type QualificationEvidenceEntryKind,
  type QualificationEvidencePolicy
} from "@agent-teams/docs-protocol/qualification";

import type {
  DocsProtocolQualificationContractV2,
  ManagedIntegrationCandidate,
  ManagedQualificationEnvironment
} from "../../application-api.js";

async function readQualificationContractV2(root: string, path: string): Promise<{
  readonly contract: DocsProtocolQualificationContractV2;
  readonly evidence: { readonly path: string; readonly digest: `sha256:${string}` };
}> {
  const source = await readContainedBoundedFile(root, path, "Qualification contract");
  const value = JSON.parse(source.bytes.toString("utf8")) as { readonly schemaVersion?: unknown };
  if (value.schemaVersion === 1) {
    throw new Error("DOCS_QUALIFICATION_V1_MIGRATION_REQUIRED: replace fixtureRoot/tests/pins/paths/gate with schemaVersion 2 scenarios; managed integration owns package and route authority.");
  }
  const schema = JSON.parse(await readFile(new URL("../../../../schemas/docs-protocol-qualification/v2.schema.json", import.meta.url), "utf8")) as object;
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(value)) {
    const details = (validate.errors ?? []).slice(0, 8).map(({ instancePath, message }) => `${instancePath || "/"} ${message ?? "is invalid"}`).join("; ");
    throw new TypeError(`docs-protocol-qualification/v2 validation failed: ${details}`);
  }
  return Object.freeze({
    contract: value as DocsProtocolQualificationContractV2,
    evidence: Object.freeze({ path: source.path, digest: source.digest })
  });
}

async function copyDisposableConsumer(
  sourceRoot: string,
  consumerRoot: string,
  policy: QualificationEvidencePolicy
): Promise<void> {
  await cp(sourceRoot, consumerRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
    dereference: false,
    async filter(source) {
      const repositoryPath = relative(sourceRoot, source).split(sep).join("/");
      if (repositoryPath === "") {return true;}
      const metadata = await lstat(source);
      const entryKind: QualificationEvidenceEntryKind = metadata.isDirectory() ? "directory"
        : metadata.isFile() ? "file"
          : metadata.isSymbolicLink() ? "symbolic-link"
            : "other";
      return !await isQualificationEvidenceExcludedPath(sourceRoot, repositoryPath, policy, "source", entryKind);
    }
  });
}

async function bootstrapManagedQualificationInstallation(
  consumerRoot: string,
  rewriteManifest: boolean
): Promise<{
  readonly adapterVersion: string;
  readonly authoringVersion: string;
  readonly docsVersion: string;
  readonly mutationVersion: string;
}> {
  const portable = await bootstrapQualificationInstallation(consumerRoot, rewriteManifest);
  const adapterManifestPath = fileURLToPath(new URL("../../../../package.json", import.meta.url));
  const [adapterManifest, consumerManifestSource] = await Promise.all([
    readFile(adapterManifestPath, "utf8").then((source) => JSON.parse(source) as { readonly version: string }),
    readFile(join(consumerRoot, "package.json"), "utf8")
  ]);
  const consumerManifest = JSON.parse(consumerManifestSource) as Record<string, unknown>;
  const existingDevDependencies = typeof consumerManifest["devDependencies"] === "object" &&
    consumerManifest["devDependencies"] !== null
    ? consumerManifest["devDependencies"] as Record<string, unknown>
    : {};
  if (rewriteManifest) {
    await writeFile(join(consumerRoot, "package.json"), `${JSON.stringify({
      ...consumerManifest,
      devDependencies: {
        ...existingDevDependencies,
        "@agent-teams/docs-protocol-agent-teams": adapterManifest.version
      }
    }, null, 2)}\n`, "utf8");
  } else if (existingDevDependencies["@agent-teams/docs-protocol-agent-teams"] !== adapterManifest.version) {
    throw new Error("Managed qualification requires the exact executing Agent Teams adapter in devDependencies.");
  }
  const scope = join(consumerRoot, "node_modules", "@agent-teams");
  await mkdir(scope, { recursive: true });
  await symlink(
    dirname(adapterManifestPath),
    join(scope, "docs-protocol-agent-teams"),
    process.platform === "win32" ? "junction" : "dir"
  );
  return Object.freeze({
    ...portable,
    adapterVersion: adapterManifest.version
  });
}

export async function overlayLocalDevelopmentSkill(consumerRoot: string, skillPath: string, enabled: boolean): Promise<void> {
  if (!enabled) {return;}
  const target = join(consumerRoot, skillPath);
  const canonicalSkill = portableQualificationSkill();
  let handle;
  try {
    handle = await open(target, constants.O_WRONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    const [opened, named] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(target, { bigint: true })
    ]);
    if (!opened.isFile() || opened.nlink !== 1n || !named.isFile() || named.isSymbolicLink() ||
      opened.dev !== named.dev || opened.ino !== named.ino || opened.birthtimeNs !== named.birthtimeNs) {
      throw new Error("unsafe Skill target");
    }
    await handle.truncate(0);
    await handle.writeFile(canonicalSkill);
    const written = await handle.stat({ bigint: true });
    if (!written.isFile() || written.nlink !== 1n || written.dev !== opened.dev || written.ino !== opened.ino ||
      written.birthtimeNs !== opened.birthtimeNs || written.size !== BigInt(canonicalSkill.byteLength)) {
      throw new Error("unstable Skill target");
    }
  } catch (cause) {
    throw new Error("Local-development qualification Skill target must be one stable, non-hardlinked regular file.", { cause });
  } finally {
    await handle?.close();
  }
}

async function collectEvidence(input: {
  readonly consumerRoot: string;
  readonly integration: ManagedIntegrationCandidate & { readonly qualification: NonNullable<ManagedIntegrationCandidate["qualification"]> };
}): Promise<{
  readonly executingModule: Buffer;
  readonly lockfileDigest: `sha256:${string}`;
  readonly packageManifestDigest: `sha256:${string}`;
  readonly profile: { readonly path: string; readonly digest: `sha256:${string}` };
  readonly skill: { readonly path: string; readonly digest: `sha256:${string}` };
}> {
  const [profile, skill, packageManifest, lockfile, executingModule] = await Promise.all([
    readContainedBoundedFile(input.consumerRoot, input.integration.profilePath, "Docs Protocol profile"),
    readContainedBoundedFile(input.consumerRoot, input.integration.skillPath, "Documentation Skill"),
    readContainedBoundedFile(input.consumerRoot, "package.json", "Package manifest"),
    readContainedBoundedFile(input.consumerRoot, "pnpm-lock.yaml", "pnpm lockfile", 64 * 1024 * 1024),
    readFile(fileURLToPath(import.meta.url))
  ]);
  return {
    executingModule,
    lockfileDigest: lockfile.digest,
    packageManifestDigest: packageManifest.digest,
    profile: { path: profile.path, digest: profile.digest },
    skill: { path: skill.path, digest: skill.digest }
  };
}

export function createNodeManagedQualificationEnvironment(
  interruptAndRecover: ManagedQualificationEnvironment["interruptAndRecover"]
): ManagedQualificationEnvironment {
  return {
    protocol: { checkV2: docsCheckV2, doctorV2: docsDoctorV2, findV2: docsFindV2, infoV2: docsInfoV2, newDocumentV2: docsNewV2, recoverV2: docsRecoverV2 },
    async resolveRoot(root) { return realpath(resolvePath(root)); },
    async readIntegration(root, path) {
      const source = await readContainedBoundedFile(root, path, "Managed integration profile");
      return { value: JSON.parse(source.bytes.toString("utf8")) as ManagedIntegrationCandidate, evidence: { path: source.path, digest: source.digest } };
    },
    readContract: readQualificationContractV2,
    snapshot,
    fileSnapshot,
    bootstrapInstallation: bootstrapManagedQualificationInstallation,
    overlaySkill: overlayLocalDevelopmentSkill,
    async createDisposable() {
      const temporary = await realpath(await mkdtemp(join(tmpdir(), "atd-q2-")));
      const consumerRoot = join(temporary, "consumer");
      return {
        consumerRoot,
        async copyFrom(sourceRoot, policy) { await copyDisposableConsumer(sourceRoot, consumerRoot, policy); },
        async dispose() { await rm(temporary, { recursive: true, force: true }); }
      };
    },
    async readScripts(root) {
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { readonly scripts?: Readonly<Record<string, unknown>> };
      return manifest.scripts;
    },
    async readGolden(root, path, label) {
      return (await readContainedBoundedFile(root, path, label)).bytes.toString("utf8");
    },
    async readDocument(root, path) { return readFile(join(root, path), "utf8"); },
    interruptAndRecover,
    applyReachability,
    collectEvidence
  };
}
