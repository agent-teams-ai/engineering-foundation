import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  Extractor,
  ExtractorConfig,
  ExtractorLogLevel
} from "@microsoft/api-extractor";
import {
  ApiDeclaredItem,
  ApiModel,
  type ApiItem
} from "@microsoft/api-extractor-model";

import { CapabilityInputError } from "../../../../../capability-runtime.js";
import {
  ContainedFileReadError,
  pathTraversesSymbolicLink,
  readContainedRegularFile
} from "../../../../../filesystem-path-safety.js";
import { assertNotCancelled } from "../../../../../strict-yaml.js";
import {
  compareCanonicalReferences,
  publicApiEntrypoints,
  type PublicApiEntrypointPolicy,
  type PublicApiEntrypointSnapshot,
  type PublicApiItem,
  type PublicApiPackagePolicy,
  type PublicApiSnapshot
} from "../../../application/model/public-api.js";
import type { PublicApiExtractor } from "../../../application/ports/public-api-extractor.js";
import { linkStagedPackageNodeModules } from "./link-staged-package-node-modules.js";

function inputError(code: string, message: string, phase: string): never {
  throw new CapabilityInputError({ code, message, phase, retryable: false });
}

const MAX_EXTRACTOR_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_STAGED_PACKAGE_BYTES = 128 * 1024 * 1024;
const MAX_STAGED_PACKAGE_FILES = 10_000;
const STAGING_DIRECTORY_PREFIX = ".agent-teams-public-api-stage-";

function contained(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return (
    relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
  );
}

function extractionReadError(error: unknown, repositoryPath: string): never {
  if (error instanceof ContainedFileReadError) {
    const code =
      error.failure === "symlink"
        ? "PUBLIC_API_PATH_SYMLINK_PROHIBITED"
        : error.failure === "escape"
          ? "PUBLIC_API_PATH_ESCAPE"
          : error.failure === "invalid"
            ? "PUBLIC_API_PATH_INVALID"
            : "PUBLIC_API_PATH_UNAVAILABLE";
    inputError(
      code,
      `Public API extraction input is unavailable or changed: ${repositoryPath}.`,
      "public-api-extraction"
    );
  }
  throw error;
}

interface StagedPackageSnapshot {
  readonly packageRoot: string;
  readonly sourcePackageRoot: string;
  readonly stagingRoot: string;
}

interface StagingBudget {
  fileCount: number;
  totalBytes: number;
}

function sourcePathFor(root: string, repositoryPath: string): string {
  const candidate = resolve(root, repositoryPath);
  if (!contained(root, candidate)) {
    inputError(
      "PUBLIC_API_PATH_ESCAPE",
      `Public API extraction path escapes the consumer repository: ${repositoryPath}.`,
      "public-api-extraction"
    );
  }
  return candidate;
}

function stagedPathForSource(input: {
  readonly snapshot: StagedPackageSnapshot;
  readonly sourcePath: string;
}): string {
  const repositoryRelativePath = relative(input.snapshot.sourcePackageRoot, input.sourcePath);
  if (
    repositoryRelativePath.length === 0 ||
    isAbsolute(repositoryRelativePath) ||
    repositoryRelativePath === ".." ||
    repositoryRelativePath.startsWith(`..${sep}`)
  ) {
    inputError(
      "PUBLIC_API_PATH_ESCAPE",
      "Configured public API evidence must stay inside the package root.",
      "public-api-extraction"
    );
  }
  return join(input.snapshot.packageRoot, repositoryRelativePath);
}

async function readStagedSourceFile(input: {
  readonly root: string;
  readonly sourcePath: string;
}): Promise<Buffer> {
  try {
    return await readContainedRegularFile({
      candidate: input.sourcePath,
      maxBytes: MAX_EXTRACTOR_INPUT_BYTES,
      root: input.root
    });
  } catch (error) {
    return extractionReadError(error, relative(input.root, input.sourcePath));
  }
}

async function stagePackageDirectory(input: {
  readonly budget: StagingBudget;
  readonly destinationDirectory: string;
  readonly root: string;
  readonly sourceDirectory: string;
}): Promise<void> {
  if (await pathTraversesSymbolicLink(input.root, input.sourceDirectory)) {
    inputError(
      "PUBLIC_API_PATH_SYMLINK_PROHIBITED",
      `Public API package tree cannot traverse a symbolic link: ${relative(input.root, input.sourceDirectory)}.`,
      "public-api-extraction"
    );
  }
  let entries;
  try {
    entries = await readdir(input.sourceDirectory, { withFileTypes: true });
  } catch {
    inputError(
      "PUBLIC_API_PATH_UNAVAILABLE",
      `Public API package directory is unavailable: ${relative(input.root, input.sourceDirectory)}.`,
      "public-api-extraction"
    );
  }
  for (const entry of entries.toSorted((left, right) =>
    compareCanonicalReferences(left.name, right.name)
  )) {
    const sourcePath = join(input.sourceDirectory, entry.name);
    // Dependencies remain source-package-local through the controlled staging
    // link below. Skip stale staging directories from interrupted old runs too.
    if (
      entry.name === "node_modules" ||
      entry.name.startsWith(STAGING_DIRECTORY_PREFIX)
    ) {
      continue;
    }
    const destinationPath = join(input.destinationDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      inputError(
        "PUBLIC_API_PATH_SYMLINK_PROHIBITED",
        `Public API package tree cannot include a symbolic link: ${relative(input.root, sourcePath)}.`,
        "public-api-extraction"
      );
    }
    if (entry.isDirectory()) {
      await mkdir(destinationPath, { mode: 0o700, recursive: true });
      await stagePackageDirectory({
        budget: input.budget,
        destinationDirectory: destinationPath,
        root: input.root,
        sourceDirectory: sourcePath
      });
      continue;
    }
    if (!entry.isFile()) {
      inputError(
        "PUBLIC_API_PATH_INVALID",
        `Public API package tree contains an unsupported entry: ${relative(input.root, sourcePath)}.`,
        "public-api-extraction"
      );
    }
    const source = await readStagedSourceFile({ root: input.root, sourcePath });
    input.budget.fileCount += 1;
    input.budget.totalBytes += source.byteLength;
    if (
      input.budget.fileCount > MAX_STAGED_PACKAGE_FILES ||
      input.budget.totalBytes > MAX_STAGED_PACKAGE_BYTES
    ) {
      inputError(
        "PUBLIC_API_PATH_INVALID",
        "Public API package input exceeds the staged extraction resource limit.",
        "public-api-extraction"
      );
    }
    await writeFile(destinationPath, source, { mode: 0o600 });
  }
}

async function stagePackageSnapshot(input: {
  readonly policy: PublicApiPackagePolicy;
  readonly root: string;
}): Promise<StagedPackageSnapshot> {
  const sourcePackageRoot = sourcePathFor(input.root, input.policy.packageRoot);
  if (await pathTraversesSymbolicLink(input.root, sourcePackageRoot)) {
    inputError(
      "PUBLIC_API_PATH_SYMLINK_PROHIBITED",
      `Public API package root cannot traverse a symbolic link: ${input.policy.packageRoot}.`,
      "public-api-extraction"
    );
  }
  try {
    if (!(await stat(sourcePackageRoot)).isDirectory()) {
      inputError(
        "PUBLIC_API_PATH_INVALID",
        `Public API package root is not a directory: ${input.policy.packageRoot}.`,
        "public-api-extraction"
      );
    }
  } catch (error) {
    if (error instanceof CapabilityInputError) {
      throw error;
    }
    inputError(
      "PUBLIC_API_PATH_UNAVAILABLE",
      `Public API package root is unavailable: ${input.policy.packageRoot}.`,
      "public-api-extraction"
    );
  }
  let stagingRoot: string;
  try {
    stagingRoot = await mkdtemp(join(dirname(sourcePackageRoot), STAGING_DIRECTORY_PREFIX));
  } catch {
    inputError(
      "PUBLIC_API_EXTRACTION_FAILED",
      "Unable to allocate a private public API staging directory.",
      "public-api-extraction"
    );
  }
  const snapshot: StagedPackageSnapshot = Object.freeze({
    packageRoot: stagingRoot,
    sourcePackageRoot,
    stagingRoot
  });
  try {
    await stagePackageDirectory({
      budget: { fileCount: 0, totalBytes: 0 },
      destinationDirectory: snapshot.packageRoot,
      root: input.root,
      sourceDirectory: snapshot.sourcePackageRoot
    });
    await linkStagedPackageNodeModules({
      sourcePackageRoot: snapshot.sourcePackageRoot,
      stagedPackageRoot: snapshot.packageRoot
    });
    return snapshot;
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function collectItems(item: ApiItem, output: PublicApiItem[]): void {
  if (item instanceof ApiDeclaredItem) {
    const parent = item.parent;
    output.push({
      canonicalReference: item.canonicalReference.toString(),
      kind: item.kind,
      ...(parent === undefined
        ? {}
        : { parentReference: parent.canonicalReference.toString() }),
      parentKind: parent?.kind ?? "None",
      signature: item.excerpt.text.replaceAll("\r\n", "\n").trim()
    });
  }
  for (const member of item.members) {
    collectItems(member, output);
  }
}

function sortedItems(items: readonly PublicApiItem[]): readonly PublicApiItem[] {
  const output = items.toSorted((left, right) =>
    compareCanonicalReferences(left.canonicalReference, right.canonicalReference)
  );
  if (
    output.some(
      (item, index) =>
        index > 0 && output[index - 1]?.canonicalReference === item.canonicalReference
    )
  ) {
    inputError(
      "PUBLIC_API_EXTRACTION_FAILED",
      "API Extractor produced duplicate canonical references for one export path.",
      "public-api-extraction"
    );
  }
  return Object.freeze(output);
}

async function extractEntrypoint(input: {
  readonly entrypoint: PublicApiEntrypointPolicy;
  readonly entryPointPath: string;
  readonly manifestPath: string;
  readonly packageRoot: string;
  readonly signal?: AbortSignal;
  readonly tsconfigPath: string;
}): Promise<PublicApiEntrypointSnapshot> {
  const outputRoot = await mkdtemp(join(tmpdir(), "agent-teams-api-extractor-"));
  try {
    const apiJsonPath = join(outputRoot, "surface.api.json");
    const config = ExtractorConfig.prepare({
      configObject: {
        projectFolder: input.packageRoot,
        mainEntryPointFilePath: input.entryPointPath,
        compiler: { tsconfigFilePath: input.tsconfigPath },
        apiReport: { enabled: false },
        docModel: {
          enabled: true,
          apiJsonFilePath: apiJsonPath,
          includeForgottenExports: false
        },
        dtsRollup: { enabled: false },
        tsdocMetadata: { enabled: false },
        newlineKind: "lf",
        testMode: true,
        messages: {
          compilerMessageReporting: {
            default: { logLevel: ExtractorLogLevel.Error }
          },
          extractorMessageReporting: {
            default: { logLevel: ExtractorLogLevel.Warning },
            "ae-forgotten-export": { logLevel: ExtractorLogLevel.Error },
            "ae-missing-release-tag": { logLevel: ExtractorLogLevel.None },
            "ae-undocumented": { logLevel: ExtractorLogLevel.None }
          },
          tsdocMessageReporting: {
            default: { logLevel: ExtractorLogLevel.Warning }
          }
        }
      },
      configObjectFullPath: undefined,
      packageJsonFullPath: input.manifestPath,
      projectFolderLookupToken: input.packageRoot
    });
    const errors: string[] = [];
    const result = Extractor.invoke(config, {
      localBuild: true,
      showVerboseMessages: false,
      messageCallback(message) {
        if (message.logLevel === ExtractorLogLevel.Error) {
          errors.push(message.messageId);
        }
        message.handled = true;
      }
    });
    assertNotCancelled(input.signal);
    if (!result.succeeded || errors.length > 0) {
      inputError(
        "PUBLIC_API_EXTRACTION_FAILED",
        `API Extractor failed with message(s): ${[...new Set(errors)].toSorted().join(", ") || "unknown"}.`,
        "public-api-extraction"
      );
    }
    const apiJsonSource = await readFile(apiJsonPath, "utf8");
    if (apiJsonSource.length > 32 * 1024 * 1024) {
      inputError(
        "PUBLIC_API_SURFACE_TOO_LARGE",
        "Generated public API surface exceeds 32 MiB.",
        "public-api-extraction"
      );
    }
    const model = new ApiModel();
    const apiPackage = model.loadPackage(apiJsonPath);
    const items: PublicApiItem[] = [];
    collectItems(apiPackage, items);
    return Object.freeze({
      exportPath: input.entrypoint.exportPath,
      items: sortedItems(items)
    });
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

export class MicrosoftPublicApiExtractor implements PublicApiExtractor {
  async extract(
    consumerRoot: string,
    policy: PublicApiPackagePolicy,
    packageVersion: string,
    signal?: AbortSignal
  ): Promise<PublicApiSnapshot> {
    assertNotCancelled(signal);
    const canonicalRoot = await realpath(consumerRoot).catch(() =>
      inputError(
        "CONSUMER_ROOT_UNAVAILABLE",
        "Consumer root must be an existing accessible directory.",
        "public-api-extraction"
      )
    );
    const staged = await stagePackageSnapshot({ policy, root: canonicalRoot });
    try {
      const manifestPath = stagedPathForSource({
        snapshot: staged,
        sourcePath: sourcePathFor(canonicalRoot, policy.manifestPath)
      });
      let manifest: { readonly name?: unknown };
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          readonly name?: unknown;
        };
      } catch (error) {
        if (error instanceof CapabilityInputError) {
          throw error;
        }
        inputError(
          "PUBLIC_API_PACKAGE_MANIFEST_INVALID",
          `Package manifest is not valid JSON: ${policy.manifestPath}.`,
          "public-api-extraction"
        );
      }
      if (manifest.name !== policy.packageName) {
        inputError(
          "PUBLIC_API_PACKAGE_IDENTITY_INVALID",
          `Package manifest identity does not match ${policy.packageName}.`,
          "public-api-extraction"
        );
      }
      const tsconfigPath = stagedPathForSource({
        snapshot: staged,
        sourcePath: sourcePathFor(canonicalRoot, policy.tsconfigPath)
      });
      const entrypoints: PublicApiEntrypointSnapshot[] = [];
      for (const entrypoint of publicApiEntrypoints(policy).toSorted((left, right) =>
        compareCanonicalReferences(left.exportPath, right.exportPath)
      )) {
        assertNotCancelled(signal);
        entrypoints.push(
          await extractEntrypoint({
            entrypoint,
            entryPointPath: stagedPathForSource({
              snapshot: staged,
              sourcePath: sourcePathFor(canonicalRoot, entrypoint.declarationEntryPoint)
            }),
            manifestPath,
            packageRoot: staged.packageRoot,
            ...(signal === undefined ? {} : { signal }),
            tsconfigPath
          })
        );
      }
      if ("entrypoints" in policy) {
        return Object.freeze({
          schemaVersion: 2,
          packageName: policy.packageName,
          packageVersion,
          extractorVersion: Extractor.version,
          entrypoints: Object.freeze(entrypoints)
        });
      }
      const entrypoint = entrypoints[0];
      if (entrypoint === undefined) {
        inputError(
          "PUBLIC_API_EXTRACTION_FAILED",
          "Public API configuration has no declaration entry point.",
          "public-api-extraction"
        );
      }
      return Object.freeze({
        schemaVersion: 1,
        packageName: policy.packageName,
        packageVersion,
        extractorVersion: Extractor.version,
        items: entrypoint.items
      });
    } finally {
      await rm(staged.stagingRoot, { recursive: true, force: true });
    }
  }
}
