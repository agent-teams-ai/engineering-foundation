import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CompilerState,
  Extractor,
  ExtractorConfig,
  ExtractorLogLevel
} from "@microsoft/api-extractor";
import {
  ApiDeclaredItem,
  ApiModel,
  ApiNamespace,
  type ApiItem
} from "@microsoft/api-extractor-model";

import { CapabilityInputError,assertNotCancelled } from "../../../../../features/validation-reporting/api.js";
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
import {
  sourcePathFor,
  stagedPathForSource,
  stagePackageSnapshot
} from "./staged-public-api-input.js";

function inputError(code: string, message: string, phase: string): never {
  throw new CapabilityInputError({ code, message, phase, retryable: false });
}

const MAX_COMPILER_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_COMPILER_INPUT_FILES = 20_000;

function declaredSignature(item: ApiDeclaredItem): string {
  const excerpt = item.excerpt.text.replaceAll("\r\n", "\n").trim();
  if (excerpt.length > 0) {
    return excerpt;
  }
  if (item instanceof ApiNamespace) {
    return `namespace ${item.displayName}`;
  }
  inputError(
    "PUBLIC_API_SIGNATURE_EMPTY",
    `API Extractor returned an empty signature for ${item.canonicalReference.toString()}.`,
    "public-api-extraction"
  );
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
      signature: declaredSignature(item)
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

interface CompilerSourceFileObservation {
  readonly fileName: string;
  readonly text: string;
}

function compilerSourceFiles(program: unknown): readonly CompilerSourceFileObservation[] {
  if (
    typeof program !== "object" ||
    program === null ||
    !("getSourceFiles" in program) ||
    typeof program.getSourceFiles !== "function"
  ) {
    inputError(
      "PUBLIC_API_EXTRACTION_FAILED",
      "API Extractor did not expose its compiler input set.",
      "public-api-extraction"
    );
  }
  const inspectedProgram = program as { getSourceFiles(): unknown };
  const sourceFiles = inspectedProgram.getSourceFiles();
  if (!Array.isArray(sourceFiles)) {
    inputError(
      "PUBLIC_API_EXTRACTION_FAILED",
      "API Extractor returned an invalid compiler input set.",
      "public-api-extraction"
    );
  }
  return sourceFiles.map((value) => {
    if (typeof value !== "object" || value === null) {
      inputError(
        "PUBLIC_API_EXTRACTION_FAILED",
        "API Extractor returned an invalid compiler source file.",
        "public-api-extraction"
      );
    }
    const sourceFile = value as Readonly<Record<string, unknown>>;
    if (
      typeof sourceFile["fileName"] !== "string" ||
      typeof sourceFile["text"] !== "string"
    ) {
      inputError(
        "PUBLIC_API_EXTRACTION_FAILED",
        "API Extractor returned an invalid compiler source file.",
        "public-api-extraction"
      );
    }
    return { fileName: sourceFile["fileName"], text: sourceFile["text"] };
  });
}

function assertCompilerInputBudget(compilerState: CompilerState): void {
  const sourceFiles = compilerSourceFiles(compilerState.program);
  const totalBytes = sourceFiles.reduce(
    (total, sourceFile) => total + Buffer.byteLength(sourceFile.text, "utf8"),
    0
  );
  if (
    sourceFiles.length > MAX_COMPILER_INPUT_FILES ||
    totalBytes > MAX_COMPILER_INPUT_BYTES
  ) {
    inputError(
      "PUBLIC_API_PATH_INVALID",
      `Public API compiler input exceeds ${MAX_COMPILER_INPUT_FILES} files or ${MAX_COMPILER_INPUT_BYTES} bytes.`,
      "public-api-extraction"
    );
  }
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
    const compilerState = CompilerState.create(config);
    assertCompilerInputBudget(compilerState);
    const errors: string[] = [];
    const result = Extractor.invoke(config, {
      compilerState,
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
      return Object.freeze({
        schemaVersion: 1,
        packageName: policy.packageName,
        packageVersion,
        extractorVersion: Extractor.version,
        entrypoints: Object.freeze(entrypoints)
      });
    } finally {
      await rm(staged.stagingRoot, { recursive: true, force: true });
    }
  }
}
