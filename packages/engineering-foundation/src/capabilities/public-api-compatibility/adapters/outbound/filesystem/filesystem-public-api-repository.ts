import {
  link,
  mkdtemp,
  opendir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { CapabilityInputError } from "../../../../../features/validation-reporting/api.js";
import {
  ContainedFileReadError,
  pathTraversesSymbolicLink,
  readContainedRegularFile
} from "../../../../../filesystem-path-safety.js";
import { assertSchema } from "../../../../../schema-catalog.js";
import { isExactVersion } from "../../../../../semantic-version.js";
import {
  assertNotCancelled,
  parseStrictYamlSource
} from "../../../../../strict-yaml.js";
import { publicApiBaselineAnchorPath } from "../../../application/model/public-api.js";
import {
  assertPackageExportCoverage,
  PackageExportCoverageError
} from "../../../application/policies/validate-package-export-coverage.js";
import type {
  PackageReleaseEvidence,
  PublicApiPackagePolicy,
  PublicApiSnapshot,
  ReleaseBump
} from "../../../application/model/public-api.js";
import type { PublicApiRepository } from "../../../application/ports/public-api-repository.js";
import {
  baselineMatchesPolicy,
  mapReleasedBaseline,
  promotionBaselineSchemaId,
  releasedBaselineSchemaId
} from "./public-api-baseline-mapper.js";
import { readChangesetsPrereleaseState } from "./changesets-prerelease-state.js";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const BUMP_RANK: Readonly<Record<ReleaseBump, number>> = {
  patch: 0,
  minor: 1,
  major: 2
};

function inputError(code: string, message: string, phase: string): never {
  throw new CapabilityInputError({ code, message, phase, retryable: false });
}

function contained(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return (
    relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
  );
}

async function canonicalRoot(consumerRoot: string): Promise<string> {
  return realpath(consumerRoot).catch(() =>
    inputError(
      "CONSUMER_ROOT_UNAVAILABLE",
      "Consumer root must be an existing accessible directory.",
      "public-api-evidence"
    )
  );
}

async function safePath(
  root: string,
  repositoryPath: string,
  kind: "directory" | "file"
): Promise<string> {
  const candidate = resolve(root, repositoryPath);
  if (await pathTraversesSymbolicLink(root, candidate)) {
    inputError(
      "PUBLIC_API_EVIDENCE_SYMLINK_PROHIBITED",
      `Public API evidence cannot traverse a symbolic link: ${repositoryPath}.`,
      "public-api-evidence"
    );
  }
  const canonical = await realpath(candidate).catch(() =>
    inputError(
      "PUBLIC_API_EVIDENCE_UNAVAILABLE",
      `Public API evidence is unavailable: ${repositoryPath}.`,
      "public-api-evidence"
    )
  );
  if (!contained(root, canonical)) {
    inputError(
      "PUBLIC_API_EVIDENCE_ESCAPE",
      `Public API evidence escapes the consumer repository: ${repositoryPath}.`,
      "public-api-evidence"
    );
  }
  const metadata = await stat(canonical);
  if (
    (kind === "file" && (!metadata.isFile() || metadata.size > MAX_INPUT_BYTES)) ||
    (kind === "directory" && !metadata.isDirectory())
  ) {
    inputError(
      "PUBLIC_API_EVIDENCE_INVALID",
      `Public API evidence is not a valid ${kind}: ${repositoryPath}.`,
      "public-api-evidence"
    );
  }
  return canonical;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputError("PUBLIC_API_EVIDENCE_INVALID", `${field} must be an object.`, "public-api-evidence");
  }
  return value as Record<string, unknown>;
}

function publicApiEvidenceReadError(
  error: unknown,
  repositoryPath: string,
  phase: string
): never {
  if (error instanceof ContainedFileReadError) {
    const code =
      error.failure === "symlink"
        ? "PUBLIC_API_EVIDENCE_SYMLINK_PROHIBITED"
        : error.failure === "escape"
          ? "PUBLIC_API_EVIDENCE_ESCAPE"
          : error.failure === "invalid"
            ? "PUBLIC_API_EVIDENCE_INVALID"
            : "PUBLIC_API_EVIDENCE_UNAVAILABLE";
    inputError(code, `Public API evidence is unavailable or changed: ${repositoryPath}.`, phase);
  }
  throw error;
}

async function readPublicApiEvidenceFile(input: {
  readonly allowMissing: true;
  readonly maxBytes: number;
  readonly repositoryPath: string;
  readonly root: string;
  readonly phase: string;
}): Promise<Buffer | undefined>;
async function readPublicApiEvidenceFile(input: {
  readonly allowMissing?: false;
  readonly maxBytes: number;
  readonly repositoryPath: string;
  readonly root: string;
  readonly phase: string;
}): Promise<Buffer>;
async function readPublicApiEvidenceFile(input: {
  readonly allowMissing?: boolean;
  readonly maxBytes: number;
  readonly repositoryPath: string;
  readonly root: string;
  readonly phase: string;
}): Promise<Buffer | undefined> {
  try {
    return await readContainedRegularFile({
      candidate: resolve(input.root, input.repositoryPath),
      maxBytes: input.maxBytes,
      root: input.root
    });
  } catch (error) {
    if (
      input.allowMissing === true &&
      error instanceof ContainedFileReadError &&
      error.failure === "missing"
    ) {
      return undefined;
    }
    return publicApiEvidenceReadError(error, input.repositoryPath, input.phase);
  }
}

function assertBaselineAnchor(policy: PublicApiPackagePolicy): void {
  const expected = publicApiBaselineAnchorPath(policy.packageName);
  if (policy.releasedBaselinePath !== expected) {
    inputError(
      "PUBLIC_API_BASELINE_ANCHOR_INVALID",
      `Released baseline path must use the stable package anchor: ${expected}.`,
      "public-api-evidence"
    );
  }
}

function strongerBump(
  current: ReleaseBump | undefined,
  candidate: unknown
): ReleaseBump | undefined {
  if (candidate !== "patch" && candidate !== "minor" && candidate !== "major") {
    return current;
  }
  return current === undefined || BUMP_RANK[candidate] > BUMP_RANK[current]
    ? candidate
    : current;
}

function changesetFrontmatter(source: string): string | undefined {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    return undefined;
  }
  if (normalized.startsWith("---\n---\n")) {
    return "";
  }
  const end = normalized.indexOf("\n---\n", 4);
  return end === -1 ? undefined : normalized.slice(4, end);
}

async function declaredBump(input: {
  readonly directory: string;
  readonly packageName: string;
  readonly root: string;
  readonly signal?: AbortSignal;
}): Promise<ReleaseBump | undefined> {
  let bump: ReleaseBump | undefined;
  const entries = [];
  const directory = resolve(input.root, input.directory);
  if (await pathTraversesSymbolicLink(input.root, directory)) {
    inputError(
      "CHANGESET_SYMLINK_PROHIBITED",
      "Changeset directory cannot traverse a symbolic link.",
      "public-api-evidence"
    );
  }
  let handle;
  try {
    handle = await opendir(directory);
  } catch {
    inputError(
      "CHANGESET_INVALID",
      "Changeset directory is not available.",
      "public-api-evidence"
    );
  }
  for await (const entry of handle) {
    assertNotCancelled(input.signal);
    if (entry.isSymbolicLink()) {
      inputError(
        "CHANGESET_SYMLINK_PROHIBITED",
        `Changeset entries cannot be symbolic links: ${entry.name}.`,
        "public-api-evidence"
      );
    }
    if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md") {
      entries.push(entry.name);
    }
  }
  for (const name of entries.toSorted()) {
    const source = await readPublicApiEvidenceFile({
      maxBytes: 1024 * 1024,
      repositoryPath: join(input.directory, name),
      root: input.root,
      phase: "public-api-evidence"
    });
    const frontmatter = changesetFrontmatter(source.toString("utf8"));
    if (frontmatter === undefined) {
      inputError(
        "CHANGESET_INVALID",
        `Changeset has invalid frontmatter: ${name}.`,
        "public-api-evidence"
      );
    }
    if (frontmatter === "") {
      continue;
    }
    const parsed = record(
      parseStrictYamlSource(frontmatter, "public-api-changeset"),
      `changeset ${name}`
    );
    bump = strongerBump(bump, parsed[input.packageName]);
  }
  return bump;
}

export class FilesystemPublicApiRepository implements PublicApiRepository {
  async readReleasedBaseline(
    consumerRoot: string,
    policy: PublicApiPackagePolicy,
    signal: AbortSignal | undefined,
    purpose: "release-promotion"
  ): Promise<PublicApiSnapshot | undefined>;
  async readReleasedBaseline(
    consumerRoot: string,
    policy: PublicApiPackagePolicy,
    signal?: AbortSignal,
    purpose?: "compatibility-check"
  ): Promise<PublicApiSnapshot>;
  async readReleasedBaseline(
    consumerRoot: string,
    policy: PublicApiPackagePolicy,
    signal?: AbortSignal,
    purpose: "compatibility-check" | "release-promotion" = "compatibility-check"
  ): Promise<PublicApiSnapshot | undefined> {
    assertNotCancelled(signal);
    assertBaselineAnchor(policy);
    const root = await canonicalRoot(consumerRoot);
    const baselineRead = {
      maxBytes: MAX_INPUT_BYTES,
      repositoryPath: policy.releasedBaselinePath,
      root,
      phase: "public-api-evidence"
    };
    const baselineSource =
      purpose === "release-promotion"
        ? await readPublicApiEvidenceFile({ ...baselineRead, allowMissing: true })
        : await readPublicApiEvidenceFile(baselineRead);
    if (baselineSource === undefined) {
      return undefined;
    }
    let input: unknown;
    try {
      input = JSON.parse(baselineSource.toString("utf8")) as unknown;
    } catch {
      inputError(
        "PUBLIC_API_BASELINE_INVALID",
        `Released API baseline is not valid JSON: ${policy.releasedBaselinePath}.`,
        "public-api-evidence"
      );
    }
    await assertSchema(releasedBaselineSchemaId(input), input, "public-api-baseline");
    return mapReleasedBaseline(input, policy, purpose === "release-promotion");
  }

  async readReleaseEvidence(
    consumerRoot: string,
    changesetDirectory: string,
    policy: PublicApiPackagePolicy,
    signal?: AbortSignal
  ): Promise<PackageReleaseEvidence> {
    assertNotCancelled(signal);
    const root = await canonicalRoot(consumerRoot);
    const manifestSource = await readPublicApiEvidenceFile({
      maxBytes: MAX_INPUT_BYTES,
      repositoryPath: policy.manifestPath,
      root,
      phase: "public-api-evidence"
    });
    let manifestInput: unknown;
    try {
      manifestInput = JSON.parse(manifestSource.toString("utf8")) as unknown;
    } catch {
      inputError(
        "PUBLIC_API_PACKAGE_MANIFEST_INVALID",
        `Package manifest is not valid JSON: ${policy.manifestPath}.`,
        "public-api-evidence"
      );
    }
    const manifest = record(manifestInput, "package manifest");
    const packageName = manifest["name"];
    const packageVersion = manifest["version"];
    if (
      packageName !== policy.packageName ||
      typeof packageVersion !== "string" ||
      !isExactVersion(packageVersion)
    ) {
      inputError(
        "PUBLIC_API_PACKAGE_IDENTITY_INVALID",
        `Package manifest identity or version is invalid: ${policy.manifestPath}.`,
        "public-api-evidence"
      );
    }
    try {
      assertPackageExportCoverage({ manifest, policy });
    } catch (error) {
      if (error instanceof PackageExportCoverageError) {
        inputError(
          "PUBLIC_API_PACKAGE_EXPORTS_INVALID",
          error.message,
          "public-api-evidence"
        );
      }
      throw error;
    }
    const [bump, preState] = await Promise.all([
      declaredBump({
        directory: changesetDirectory,
        packageName: policy.packageName,
        root,
        ...(signal === undefined ? {} : { signal })
      }),
      readChangesetsPrereleaseState({
        directory: changesetDirectory,
        packageName: policy.packageName,
        root
      })
    ]);
    return {
      packageName: policy.packageName,
      packageVersion,
      ...(bump === undefined ? {} : { declaredBump: bump }),
      ...(preState === undefined
        ? {}
        : {
            prereleaseInitialVersion: preState.initialVersion,
            prereleaseTag: preState.tag
          })
    };
  }

  async writeReleasedBaseline(
    consumerRoot: string,
    policy: PublicApiPackagePolicy,
    snapshot: PublicApiSnapshot,
    signal?: AbortSignal,
    mode: "create" | "replace" = "replace"
  ): Promise<void> {
    assertNotCancelled(signal);
    assertBaselineAnchor(policy);
    const root = await canonicalRoot(consumerRoot);
    const requestedBaselinePath = resolve(root, policy.releasedBaselinePath);
    const baselinePath =
      mode === "replace"
        ? await safePath(root, policy.releasedBaselinePath, "file")
        : join(
            await safePath(root, dirname(policy.releasedBaselinePath), "directory"),
            policy.releasedBaselinePath.slice(policy.releasedBaselinePath.lastIndexOf("/") + 1)
          );
    if (baselinePath !== requestedBaselinePath) {
      inputError(
        "PUBLIC_API_EVIDENCE_ESCAPE",
        `Public API evidence escapes the consumer repository: ${policy.releasedBaselinePath}.`,
        "public-api-baseline-promotion"
      );
    }
    if (!baselineMatchesPolicy(snapshot, policy)) {
      inputError(
        "PUBLIC_API_BASELINE_INVALID",
        "Public API snapshot schema does not match the configured package policy.",
        "public-api-baseline-promotion"
      );
    }
    await assertSchema(
      promotionBaselineSchemaId(policy),
      snapshot,
      "public-api-baseline-promotion"
    );
    const temporaryDirectory = await mkdtemp(
      join(dirname(baselinePath), ".public-api-baseline-")
    );
    try {
      const temporaryPath = join(temporaryDirectory, "baseline.json");
      await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o644
      });
      assertNotCancelled(signal);
      if (mode === "create") {
        try {
          await link(temporaryPath, baselinePath);
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            String(error.code) === "EEXIST"
          ) {
            inputError(
              "PUBLIC_API_BASELINE_BOOTSTRAP_CONFLICT",
              `Initial public API baseline appeared concurrently: ${policy.releasedBaselinePath}.`,
              "public-api-baseline-promotion"
            );
          }
          throw error;
        }
      } else {
        await rename(temporaryPath, baselinePath);
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
