import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
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

import { CapabilityInputError } from "../../../../../capability-runtime.js";
import { pathTraversesSymbolicLink } from "../../../../../filesystem-path-safety.js";
import { assertNotCancelled } from "../../../../../strict-yaml.js";
import { compareCanonicalReferences } from "../../../application/model/public-api.js";
import type {
  PublicApiItem,
  PublicApiPackagePolicy,
  PublicApiSnapshot
} from "../../../application/model/public-api.js";
import type { PublicApiExtractor } from "../../../application/ports/public-api-extractor.js";

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

async function safePath(
  root: string,
  repositoryPath: string,
  kind: "directory" | "file"
): Promise<string> {
  const candidate = resolve(root, repositoryPath);
  if (await pathTraversesSymbolicLink(root, candidate)) {
    inputError(
      "PUBLIC_API_PATH_SYMLINK_PROHIBITED",
      `Public API ${kind} cannot traverse a symbolic link: ${repositoryPath}.`,
      "public-api-extraction"
    );
  }
  const canonical = await realpath(candidate).catch(() =>
    inputError(
      "PUBLIC_API_PATH_UNAVAILABLE",
      `Public API ${kind} is unavailable: ${repositoryPath}.`,
      "public-api-extraction"
    )
  );
  if (!contained(root, canonical)) {
    inputError(
      "PUBLIC_API_PATH_ESCAPE",
      `Public API ${kind} escapes the consumer repository: ${repositoryPath}.`,
      "public-api-extraction"
    );
  }
  const metadata = await stat(canonical);
  if ((kind === "file" && !metadata.isFile()) || (kind === "directory" && !metadata.isDirectory())) {
    inputError(
      "PUBLIC_API_PATH_INVALID",
      `Public API path is not a ${kind}: ${repositoryPath}.`,
      "public-api-extraction"
    );
  }
  return canonical;
}

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
    const [packageRoot, manifestPath, entryPoint, tsconfigPath] = await Promise.all([
      safePath(canonicalRoot, policy.packageRoot, "directory"),
      safePath(canonicalRoot, policy.manifestPath, "file"),
      safePath(canonicalRoot, policy.declarationEntryPoint, "file"),
      safePath(canonicalRoot, policy.tsconfigPath, "file")
    ]);
    let manifest: { readonly name?: unknown };
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        readonly name?: unknown;
      };
    } catch {
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
    const outputRoot = await mkdtemp(join(tmpdir(), "agent-teams-api-extractor-"));
    try {
      const apiJsonPath = join(outputRoot, "surface.api.json");
      const config = ExtractorConfig.prepare({
        configObject: {
          projectFolder: packageRoot,
          mainEntryPointFilePath: entryPoint,
          compiler: { tsconfigFilePath: tsconfigPath },
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
        packageJsonFullPath: manifestPath,
        projectFolderLookupToken: packageRoot
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
      assertNotCancelled(signal);
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
      return {
        schemaVersion: 1,
        packageName: policy.packageName,
        packageVersion,
        extractorVersion: Extractor.version,
        items: items.toSorted((left, right) =>
          compareCanonicalReferences(left.canonicalReference, right.canonicalReference)
        )
      };
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  }
}
