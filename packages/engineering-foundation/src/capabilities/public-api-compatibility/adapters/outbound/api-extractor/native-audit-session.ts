import { bindAuditCompilerReferences } from "./audit-compiler-bindings.js";
import {
  NATIVE_EXTRACTOR_VERSION,
  nativeCompilerDiagnostics,
  type NativePublicApiContext,
} from "./native-public-api-engine.js";
import { createNativePublicApiModel } from "./native-public-api-model.js";

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

import { basename, dirname, join, resolve } from "node:path";

import {
  type AuditDeclaration,
  type AuditDiagnostic,
  type AuditObservation,
} from "../../../application/model/public-api-observation.js";

import {
  auditDigest,
  AUDIT_MAX_BYTES,
  auditPackagePolicy,
} from "../filesystem/public-api-audit-inputs.js";
import { mapReleasedBaseline } from "../filesystem/public-api-baseline-mapper.js";

import type { ObservationContext } from "./native-audit-context.js";
import { readModel, defaultLibrary } from "./native-audit-model.js";
import { validateCompilerSources } from "./native-audit-configuration.js";
import { revalidateObservationInputs } from "./native-audit-evidence.js";

export interface NativeAuditObservationState {
  readonly diagnostics: AuditDiagnostic[];
  readonly unsupported: string[];
  compilerOptions: Readonly<Record<string, unknown>>;
  invocation: AuditObservation["invocation"];
  collected: boolean;
  modelPresent: boolean;
  modelDigest: string | undefined;
  items: AuditDeclaration[];
  sources: readonly {
    readonly fileName: string;
    readonly text: string;
    readonly library: boolean;
  }[];
  storedSurface: AuditObservation["storedSurface"];
}
export function createNativeAuditObservationState(): NativeAuditObservationState {
  return {
    diagnostics: [],
    unsupported: [],
    compilerOptions: {},
    invocation: { outcome: "not-invoked", succeeded: false, errorCount: null, warningCount: null },
    collected: false,
    modelPresent: false,
    modelDigest: undefined,
    items: [],
    sources: [],
    storedSurface: undefined,
  };
}
export async function observeNativeAuditEntrypoint(
  native: NativePublicApiContext,
  context: ObservationContext,
  state: NativeAuditObservationState,
  configFiles: Map<string, string>,
  metadataPresence: ReadonlyMap<string, boolean>,
): Promise<void> {
  const { input, pkg, entry } = context;
  const outputRoot = dirname(input.consumerRoot);

  const { configFilePath: _configPath, ...options } = native.config.options;
  state.compilerOptions = options;
  state.diagnostics.push(...(await nativeCompilerDiagnostics(native)));
  state.collected = true;
  const checkedSources = await validateCompilerSources(native, context);
  const checkedInputs = [];
  for (const source of checkedSources) {
    checkedInputs.push({
      fileName: source.fileName,
      text: source.text,
      library: await defaultLibrary(native, source),
    });
  }
  state.sources = checkedInputs;
  for (const path of native.readFiles) {
    if (basename(path) === "package.json" && context.allowed.has(resolve(path))) {
      configFiles.set(resolve(path), auditDigest(readFileSync(path)));
    }
  }
  if (entry !== undefined) {
    const modelPath = join(outputRoot, "surface.api.json");
    try {
      if (
        state.diagnostics.some(
          (diagnostic) => diagnostic.source === "compiler" && diagnostic.severity === "error",
        )
      ) {
        throw new Error("Native public API extraction cannot model compiler errors.");
      }
      const result = await createNativePublicApiModel(native, {
        packageName: pkg.packageName,
        entryPointPath: resolve(input.consumerRoot, entry.declarationEntryPoint),
        includeForgottenExports: true,
        untrimmedObservation: true,
        referenceProjection: "declaration-graph",
      });
      state.diagnostics.push(
        ...result.diagnostics.filter((diagnostic) => diagnostic.source !== "compiler"),
      );
      state.invocation = {
        outcome: "completed",
        succeeded: result.succeeded,
        errorCount: result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")
          .length,
        warningCount: result.diagnostics.filter((diagnostic) => diagnostic.severity === "warning")
          .length,
      };
      result.apiPackage.saveToJsonFile(modelPath, {
        toolPackage: "@agent-teams/engineering-foundation",
        toolVersion: NATIVE_EXTRACTOR_VERSION,
      });
      try {
        const modelBytes = await readFile(modelPath);
        state.modelPresent = true;
        state.modelDigest = auditDigest(modelBytes);
        if (modelBytes.length > AUDIT_MAX_BYTES) {
          throw new Error("Audit model byte budget exhausted.");
        }
        state.items = await readModel(
          result.model,
          result.apiPackage,
          {
            subject: input.subject,
            packageName: pkg.packageName,
            exportPath: entry.exportPath,
          },
          native,
        );
        await bindAuditCompilerReferences({
          program: native.program,
          checker: native.checker,
          project: native.project,
          root: input.consumerRoot,
          declarations: input.declarations,
          items: state.items,
          declarationBindings: result.declarationBindings,
          bindings: context.dependencyBindings,
        });
        await validateModelExports(
          native,
          resolve(input.consumerRoot, entry.declarationEntryPoint),
          state.items,
        );
        state.storedSurface = await storedSurfaceFromModel(result, context, native);
      } catch (error) {
        state.unsupported.push(
          `model-unavailable: ${String(error).replaceAll(outputRoot, "<audit-model-output>")}`,
        );
      }
    } catch (error) {
      state.invocation = {
        outcome: "exception",
        succeeded: false,
        errorCount: null,
        warningCount: null,
        exception: String(error).replaceAll(outputRoot, "<audit-model-output>"),
      };
    }
  } else {
    state.storedSurface = mapReleasedBaseline(
      {
        schemaVersion: 1,
        packageName: pkg.packageName,
        packageVersion: pkg.packageVersion,
        extractorVersion: NATIVE_EXTRACTOR_VERSION,
        entrypoints: [],
      },
      auditPackagePolicy(pkg),
    );
  }
  await revalidateObservationInputs(context, metadataPresence, state.sources);
}

async function storedSurfaceFromModel(
  result: Awaited<ReturnType<typeof createNativePublicApiModel>>,
  context: ObservationContext,
  native: NativePublicApiContext,
): Promise<NonNullable<AuditObservation["storedSurface"]>> {
  const { input, pkg, entry } = context;
  if (entry === undefined) {
    throw new Error("Audit model has no selected entrypoint.");
  }
  return mapReleasedBaseline(
    {
      schemaVersion: 1,
      packageName: pkg.packageName,
      packageVersion: pkg.packageVersion,
      extractorVersion: NATIVE_EXTRACTOR_VERSION,
      entrypoints: [
        {
          exportPath: entry.exportPath,
          items: (
            await readModel(
              result.model,
              result.apiPackage,
              {
                subject: input.subject,
                packageName: pkg.packageName,
                exportPath: entry.exportPath,
              },
              native,
              true,
            )
          )
            .map((item) => ({
              canonicalReference: item.identity.canonicalReference,
              kind: item.kind,
              parentKind: item.parentKind,
              parentReference: item.parentReference,
              signature:
                item.excerpt.replaceAll("\r\n", "\n").trim() ||
                (item.kind === "Namespace" ? `namespace ${item.displayName}` : ""),
            }))
            .toSorted((a, b) =>
              a.canonicalReference < b.canonicalReference
                ? -1
                : a.canonicalReference > b.canonicalReference
                  ? 1
                  : 0,
            ),
        },
      ],
    },
    auditPackagePolicy(pkg),
  );
}

async function validateModelExports(
  context: NativePublicApiContext,
  entryPoint: string,
  items: readonly AuditDeclaration[],
): Promise<void> {
  const entrySource = await context.program.getSourceFile(entryPoint);
  const moduleSymbol =
    entrySource === undefined ? undefined : await context.checker.getSymbolAtLocation(entrySource);
  if (moduleSymbol === undefined) {
    throw new Error("Unsupported declaration entrypoint module binding.");
  }
  for (const exported of await context.checker.getExportsOfModule(moduleSymbol)) {
    if (
      !items.some(
        (item) =>
          item.public && item.parentKind === "EntryPoint" && item.displayName === exported.name,
      )
    ) {
      throw new Error(`Unsupported model omission for compiler export: ${exported.name}.`);
    }
  }
  if (items.some((item) => item.public && item.kind !== "Namespace" && !item.excerpt.trim())) {
    throw new Error("Empty historical declaration signature.");
  }
}
