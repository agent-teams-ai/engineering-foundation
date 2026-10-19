import { readFile, realpath, rm } from "node:fs/promises";
import { ApiDeclaredItem, ApiNamespace, type ApiItem } from "@microsoft/api-extractor-model";
import type { PublicApiSourceEvidence } from "../../../application/ports/public-api-evidence.js";
import { assertNotCancelled, isPublicApiInputError, publicApiInputError } from "../../../application/policies/public-api-evidence-errors.js";
import { compareCanonicalReferences, publicApiEntrypoints, type PublicApiEntrypointSnapshot, type PublicApiItem, type PublicApiPackagePolicy, type PublicApiSnapshot } from "../../../application/model/public-api.js";
import type { PublicApiExtractor } from "../../../application/ports/public-api-extractor.js";
import { sourcePathFor, stagedPathForSource, stagePackageSnapshot } from "./staged-public-api-input.js";
import { NATIVE_EXTRACTOR_VERSION, withNativePublicApiProject } from "./native-public-api-engine.js";
import { captureNativePublicApiInputs } from "./native-public-api-inputs.js";
import { createNativePublicApiModel } from "./native-public-api-model.js";

function inputError(code: string, message: string): never {
  publicApiInputError(code, message, "public-api-extraction");
}
function collectItems(item: ApiItem, output: PublicApiItem[]): void {
  if (item instanceof ApiDeclaredItem) {
    const signature = item.excerpt.text.replaceAll("\r\n", "\n").trim() || (item instanceof ApiNamespace ? `namespace ${item.displayName}` : "");
    if (signature.length === 0) { inputError("PUBLIC_API_SIGNATURE_EMPTY", `Native API model returned an empty signature for ${item.canonicalReference.toString()}.`); }
    if (signature.length > 10_000) { inputError("PUBLIC_API_SURFACE_TOO_LARGE", "Native public API item signature exceeds 10,000 characters."); }
    output.push({ canonicalReference: item.canonicalReference.toString(), kind: item.kind,
      ...(item.parent === undefined ? {} : { parentReference: item.parent.canonicalReference.toString() }),
      parentKind: item.parent?.kind ?? "None", signature });
  }
  for (const member of item.members) { collectItems(member, output); }
}
function sortedItems(items: readonly PublicApiItem[]): readonly PublicApiItem[] {
  const sorted = items.toSorted((left, right) => compareCanonicalReferences(left.canonicalReference, right.canonicalReference));
  if (sorted.some((item, index) => index > 0 && sorted[index - 1]?.canonicalReference === item.canonicalReference)) {
    inputError("PUBLIC_API_EXTRACTION_FAILED", "Native API model produced duplicate canonical references for one export path.");
  }
  return Object.freeze(sorted);
}

export class TypeScriptPublicApiExtractor implements PublicApiExtractor {
  readonly #evidence: PublicApiSourceEvidence;
  constructor(evidence: PublicApiSourceEvidence) { this.#evidence = evidence; }

  async extract(consumerRoot: string, policy: PublicApiPackagePolicy, packageVersion: string, signal?: AbortSignal): Promise<PublicApiSnapshot> {
    assertNotCancelled(signal);
    const canonicalRoot = await realpath(consumerRoot).catch(() => inputError("CONSUMER_ROOT_UNAVAILABLE", "Consumer root must be an existing accessible directory."));
    const staged = await stagePackageSnapshot({ policy, root: canonicalRoot }, this.#evidence);
    try {
      const manifestPath = stagedPathForSource({ snapshot: staged, sourcePath: sourcePathFor(canonicalRoot, policy.manifestPath) });
      let manifest: { readonly name?: unknown };
      try { manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { readonly name?: unknown }; }
      catch (error) {
        if (isPublicApiInputError(error)) { throw error; }
        inputError("PUBLIC_API_PACKAGE_MANIFEST_INVALID", `Package manifest is not valid JSON: ${policy.manifestPath}.`);
      }
      if (manifest.name !== policy.packageName) { inputError("PUBLIC_API_PACKAGE_IDENTITY_INVALID", `Package manifest identity does not match ${policy.packageName}.`); }
      const tsconfigPath = stagedPathForSource({ snapshot: staged, sourcePath: sourcePathFor(canonicalRoot, policy.tsconfigPath) });
      const files = await captureNativePublicApiInputs({ stagingRoot: staged.stagingRoot, packageRoot: staged.packageRoot, ...(signal === undefined ? {} : { signal }) });
      const entrypoints: PublicApiEntrypointSnapshot[] = [];
      for (const entrypoint of publicApiEntrypoints(policy).toSorted((left, right) => compareCanonicalReferences(left.exportPath, right.exportPath))) {
        assertNotCancelled(signal);
        const entryPointPath = stagedPathForSource({ snapshot: staged, sourcePath: sourcePathFor(canonicalRoot, entrypoint.declarationEntryPoint) });
        const observation = await withNativePublicApiProject({ cwd: staged.stagingRoot, configPath: tsconfigPath, files, declarationEntryPoint: entryPointPath, ...(signal === undefined ? {} : { signal }) }, async context => {
          const result = await createNativePublicApiModel(context, { packageName: policy.packageName, entryPointPath, includeForgottenExports: false, referenceProjection: "stored-surface" });
          assertNotCancelled(signal);
          if (!result.succeeded) {
            const errors = [...new Set(result.diagnostics.filter(diagnostic => diagnostic.severity === "error").map(diagnostic => diagnostic.id))].toSorted();
            inputError("PUBLIC_API_EXTRACTION_FAILED", `Native API extraction failed with message(s): ${errors.join(", ") || "unknown"}.`);
          }
          const items: PublicApiItem[] = [];
          collectItems(result.apiPackage, items);
          return { exportPath: entrypoint.exportPath, items: sortedItems(items) };
        });
        entrypoints.push(Object.freeze(observation));
      }
      const snapshot: PublicApiSnapshot = Object.freeze({ schemaVersion: 1, packageName: policy.packageName, packageVersion,
        extractorVersion: NATIVE_EXTRACTOR_VERSION, entrypoints: Object.freeze(entrypoints) });
      if (Buffer.byteLength(JSON.stringify(snapshot)) > 32 * 1024 * 1024) { inputError("PUBLIC_API_SURFACE_TOO_LARGE", "Generated native public API surface exceeds 32 MiB."); }
      return snapshot;
    } finally { await rm(staged.stagingRoot, { recursive: true, force: true }); }
  }
}
