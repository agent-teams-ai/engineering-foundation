import {
  lstat,
  mkdtemp,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { CapabilityInputError } from "../../../../../capability-runtime.js";
import { pathTraversesSymbolicLink } from "../../../../../filesystem-path-safety.js";
import { assertSchema } from "../../../../../schema-catalog.js";
import { isExactVersion } from "../../../../../semantic-version.js";
import {
  assertNotCancelled,
  parseStrictYamlSource
} from "../../../../../strict-yaml.js";
import { compareCanonicalReferences } from "../../../application/model/public-api.js";
import type {
  PackageReleaseEvidence,
  PublicApiItem,
  PublicApiPackagePolicy,
  PublicApiSnapshot,
  ReleaseBump
} from "../../../application/model/public-api.js";
import type { PublicApiRepository } from "../../../application/ports/public-api-repository.js";

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

function mapItem(value: unknown, index: number): PublicApiItem {
  const item = record(value, `items[${index}]`);
  return Object.freeze({
    canonicalReference: String(item["canonicalReference"]),
    kind: String(item["kind"]),
    ...(typeof item["parentReference"] === "string"
      ? { parentReference: item["parentReference"] }
      : {}),
    parentKind: String(item["parentKind"]),
    signature: String(item["signature"])
  });
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
  const end = normalized.indexOf("\n---\n", 4);
  return end === -1 ? undefined : normalized.slice(4, end);
}

async function declaredBump(
  directory: string,
  packageName: string,
  signal?: AbortSignal
): Promise<ReleaseBump | undefined> {
  let bump: ReleaseBump | undefined;
  const entries = [];
  const handle = await opendir(directory);
  for await (const entry of handle) {
    assertNotCancelled(signal);
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
    const path = resolve(directory, name);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) {
      inputError(
        "CHANGESET_INVALID",
        `Changeset must be a regular file no larger than 1 MiB: ${name}.`,
        "public-api-evidence"
      );
    }
    const frontmatter = changesetFrontmatter(await readFile(path, "utf8"));
    if (frontmatter === undefined) {
      inputError(
        "CHANGESET_INVALID",
        `Changeset has invalid frontmatter: ${name}.`,
        "public-api-evidence"
      );
    }
    const parsed = record(
      parseStrictYamlSource(frontmatter, "public-api-changeset"),
      `changeset ${name}`
    );
    bump = strongerBump(bump, parsed[packageName]);
  }
  return bump;
}

export class FilesystemPublicApiRepository implements PublicApiRepository {
  async readReleasedBaseline(
    consumerRoot: string,
    policy: PublicApiPackagePolicy,
    signal?: AbortSignal
  ): Promise<PublicApiSnapshot> {
    assertNotCancelled(signal);
    const root = await canonicalRoot(consumerRoot);
    const baselinePath = await safePath(root, policy.releasedBaselinePath, "file");
    let input: unknown;
    try {
      input = JSON.parse(await readFile(baselinePath, "utf8")) as unknown;
    } catch {
      inputError(
        "PUBLIC_API_BASELINE_INVALID",
        `Released API baseline is not valid JSON: ${policy.releasedBaselinePath}.`,
        "public-api-evidence"
      );
    }
    await assertSchema(
      "package-public-api-baseline/v1",
      input,
      "public-api-baseline"
    );
    const baseline = record(input, "released API baseline");
    const itemsInput = baseline["items"];
    if (!Array.isArray(itemsInput)) {
      inputError(
        "PUBLIC_API_BASELINE_INVALID",
        "Released API baseline items must be an array.",
        "public-api-evidence"
      );
    }
    const items = itemsInput.map(mapItem);
    const references = items.map((item) => item.canonicalReference);
    if (
      new Set(references).size !== references.length ||
      references.some(
        (value, index) =>
          value !== references.toSorted(compareCanonicalReferences)[index]
      )
    ) {
      inputError(
        "PUBLIC_API_BASELINE_INVALID",
        "Released API baseline items must have unique sorted canonical references.",
        "public-api-evidence"
      );
    }
    const packageName = String(baseline["packageName"]);
    if (packageName !== policy.packageName) {
      inputError(
        "PUBLIC_API_BASELINE_INVALID",
        `Released API baseline package does not match ${policy.packageName}.`,
        "public-api-evidence"
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      packageName,
      packageVersion: String(baseline["packageVersion"]),
      extractorVersion: String(baseline["extractorVersion"]),
      items: Object.freeze(items)
    });
  }

  async readReleaseEvidence(
    consumerRoot: string,
    changesetDirectory: string,
    policy: PublicApiPackagePolicy,
    signal?: AbortSignal
  ): Promise<PackageReleaseEvidence> {
    assertNotCancelled(signal);
    const root = await canonicalRoot(consumerRoot);
    const [manifestPath, changesetPath] = await Promise.all([
      safePath(root, policy.manifestPath, "file"),
      safePath(root, changesetDirectory, "directory")
    ]);
    let manifestInput: unknown;
    try {
      manifestInput = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
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
    const bump = await declaredBump(changesetPath, policy.packageName, signal);
    return {
      packageName: policy.packageName,
      packageVersion,
      ...(bump === undefined ? {} : { declaredBump: bump })
    };
  }

  async isAcceptedDecision(
    consumerRoot: string,
    decisionPath: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    assertNotCancelled(signal);
    const root = await canonicalRoot(consumerRoot);
    const source = await readFile(await safePath(root, decisionPath, "file"), "utf8");
    const metadataLines = source.replaceAll("\r\n", "\n").split("\n").slice(0, 30);
    const heading = metadataLines[0] ?? "";
    const sectionBoundary = metadataLines.findIndex(
      (line, index) => index > 0 && line.startsWith("## ")
    );
    const firstSection = metadataLines.slice(
      0,
      sectionBoundary === -1 ? metadataLines.length : sectionBoundary
    );
    return (
      /^# ADR-[0-9]{4}:/u.test(heading) &&
      firstSection.some((line) => line.trim() === "Status: Accepted")
    );
  }

  async writeReleasedBaseline(
    consumerRoot: string,
    policy: PublicApiPackagePolicy,
    snapshot: PublicApiSnapshot,
    signal?: AbortSignal
  ): Promise<void> {
    assertNotCancelled(signal);
    const root = await canonicalRoot(consumerRoot);
    const baselinePath = await safePath(root, policy.releasedBaselinePath, "file");
    await assertSchema(
      "package-public-api-baseline/v1",
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
      await rename(temporaryPath, baselinePath);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
