import { opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalRoot, readPublicApiEvidenceFile, writePublicApiEvidenceFile } from "./public-api-evidence-files.js";
import { assertNotCancelled, publicApiInputError } from "../../../application/policies/public-api-evidence-errors.js";
import type { PublicApiRepositoryEvidence } from "../../../application/ports/public-api-evidence.js";
import type { PublicApiSchemaAssertion } from "../../schema-validation.js";
import { isExactVersion } from "../../../../../semantic-version.js";
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
  publicApiInputError(code, message, phase);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputError("PUBLIC_API_EVIDENCE_INVALID", `${field} must be an object.`, "public-api-evidence");
  }
  return value as Record<string, unknown>;
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
}, evidence: PublicApiRepositoryEvidence): Promise<ReleaseBump | undefined> {
  let bump: ReleaseBump | undefined;
  const entries = [];
  const directory = resolve(input.root, input.directory);
  if (await evidence.paths.traversesSymbolicLink(input.root, directory)) {
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
    }, evidence.files);
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
      evidence.parseYaml(frontmatter, "public-api-changeset"),
      `changeset ${name}`
    );
    bump = strongerBump(bump, parsed[input.packageName]);
  }
  return bump;
}

export class FilesystemPublicApiRepository implements PublicApiRepository {
  readonly #assertSchema: PublicApiSchemaAssertion;
  readonly #evidence: PublicApiRepositoryEvidence;

  constructor(assertSchema: PublicApiSchemaAssertion, evidence: PublicApiRepositoryEvidence) {
    this.#assertSchema = assertSchema;
    this.#evidence = evidence;
  }

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
        ? await readPublicApiEvidenceFile({ ...baselineRead, allowMissing: true }, this.#evidence.files)
        : await readPublicApiEvidenceFile(baselineRead, this.#evidence.files);
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
    await this.#assertSchema(releasedBaselineSchemaId(input), input, "public-api-baseline");
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
    }, this.#evidence.files);
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
      }, this.#evidence),
      readChangesetsPrereleaseState({
        directory: changesetDirectory,
        packageName: policy.packageName,
        root
      }, this.#evidence.files)
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
    await writePublicApiEvidenceFile(consumerRoot, policy.releasedBaselinePath, snapshot, {
      mode, ...(signal === undefined ? {} : { signal }),
      validate: async () => {
    if (!baselineMatchesPolicy(snapshot, policy)) {
      inputError(
        "PUBLIC_API_BASELINE_INVALID",
        "Public API snapshot schema does not match the configured package policy.",
        "public-api-baseline-promotion"
      );
    }
    await this.#assertSchema(
      promotionBaselineSchemaId(policy),
      snapshot,
      "public-api-baseline-promotion"
    );
      }
    }, this.#evidence);
  }
}
