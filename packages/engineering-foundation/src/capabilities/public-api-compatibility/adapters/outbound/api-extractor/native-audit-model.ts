import { compilerLibraryRoot } from "./load-pinned-audit-sdk.js";

import { type NativePublicApiContext } from "./native-public-api-engine.js";

import { realpathSync } from "node:fs";

import { basename, dirname } from "node:path";

import { SymbolFlags } from "typescript/unstable/async";
import type { SourceFile } from "typescript/unstable/ast";
import {
  ApiDeclaredItem,
  ExcerptTokenKind,
  ApiExportedMixin,
  ApiReleaseTagMixin,
  ReleaseTag,
  type ApiModel,
  type ApiPackage,
  type ApiItem,
} from "@microsoft/api-extractor-model";

import {
  type AuditDeclaration,
  type AuditObservation,
  type AuditReference,
} from "../../../application/model/public-api-observation.js";

import { auditDigest, AUDIT_MAX_FILES } from "../filesystem/public-api-audit-inputs.js";

const BUILTINS = new Set([
  "AbortSignal",
  "Error",
  "Extract",
  "NoInfer",
  "Promise",
  "Readonly",
  "Record",
  "Uint8Array",
]);
export function libraryFile(path: string): boolean {
  const resolved = realpathSync(path);
  return dirname(resolved) === compilerLibraryRoot && /^lib\..*\.d\.ts$/u.test(basename(resolved));
}
export async function nativeSources(
  context: NativePublicApiContext,
): Promise<readonly SourceFile[]> {
  const sources: SourceFile[] = [];
  for (const path of await context.program.getSourceFileNames()) {
    const source = await context.program.getSourceFile(path);
    if (source === undefined) {
      throw new Error("Native compiler source is unavailable.");
    }
    sources.push(source);
  }
  return sources;
}
export async function defaultLibrary(
  context: NativePublicApiContext,
  source: SourceFile,
): Promise<boolean> {
  return (await context.program.getSourceFileMetadata(source.fileName))?.isDefaultLibrary === true;
}
async function builtin(
  reference: string | null,
  context: NativePublicApiContext,
): Promise<AuditReference["library"] | undefined> {
  const name = /^!([A-Za-z][A-Za-z0-9]*):(?:interface|type|var)$/u.exec(reference ?? "")?.[1];
  if (name === undefined || !BUILTINS.has(name)) {
    return;
  }
  const identities = new Set<string>();
  let found = false;
  // Every source must resolve this spelling exclusively to actual pinned libraries.
  // A local shadow or any merged augmentation prevents external-library admission.
  for (const source of await nativeSources(context)) {
    if (await defaultLibrary(context, source)) {
      continue;
    }
    const symbol = await context.checker.resolveName(
      name,
      SymbolFlags.Type | SymbolFlags.Value,
      source,
    );
    if (symbol === undefined || symbol.declarations.length === 0) {
      return;
    }
    found = true;
    for (const handle of symbol.declarations) {
      const declaration = await handle.resolve(context.project);
      if (declaration === undefined) {
        return;
      }
      const file = declaration.getSourceFile();
      if (!(await defaultLibrary(context, file)) || !libraryFile(file.fileName)) {
        return;
      }
      identities.add(`${basename(file.fileName)}:${auditDigest(file.text)}`);
    }
  }
  return found ? { symbol: name, declarations: [...identities].toSorted() } : undefined;
}

async function modelReferences(
  item: ApiDeclaredItem,
  model: ApiModel,
  identity: AuditDeclaration["identity"],
  context: NativePublicApiContext,
): Promise<AuditReference[]> {
  const references: AuditReference[] = [];
  for (const token of item.excerpt.spannedTokens.filter(
    (candidate) => candidate.kind === ExcerptTokenKind.Reference,
  )) {
    const reference = token.canonicalReference;
    const target =
      reference === undefined
        ? undefined
        : model.resolveDeclarationReference(reference, item).resolvedApiItem;
    const library =
      target === undefined ? await builtin(reference?.toString() ?? null, context) : undefined;
    references.push({
      text: token.text,
      canonicalReference: reference?.toString() ?? null,
      resolution:
        target !== undefined
          ? "local"
          : library !== undefined
            ? "verified-external-library"
            : "unresolved",
      ...(target === undefined
        ? {}
        : { target: { ...identity, canonicalReference: target.canonicalReference.toString() } }),
      ...(library === undefined ? {} : { library }),
    });
  }
  return references;
}

export async function readModel(
  model: ApiModel,
  pkg: ApiPackage,
  observation: Pick<AuditObservation, "subject" | "packageName"> & { readonly exportPath: string },
  context: NativePublicApiContext,
  historical = false,
): Promise<AuditDeclaration[]> {
  if (pkg.name !== observation.packageName || pkg.entryPoints.length !== 1) {
    throw new Error("Unsupported audit model package/entrypoint identity.");
  }
  const output: AuditDeclaration[] = [];
  async function walk(item: ApiItem, parentPublic: boolean): Promise<void> {
    if (output.length >= AUDIT_MAX_FILES) {
      throw new Error("Audit model node budget exhausted.");
    }
    // Historical production models trim internal containers and omit forgotten exports.
    if (
      historical &&
      ApiReleaseTagMixin.isBaseClassOf(item) &&
      item.releaseTag === ReleaseTag.Internal
    ) {
      return;
    }
    const exported = ApiExportedMixin.isBaseClassOf(item) ? item.isExported : null;
    const isPublic = parentPublic && exported !== false;
    if (historical && !isPublic) {
      return;
    }
    if (item instanceof ApiDeclaredItem) {
      const identity = {
        subject: observation.subject,
        packageName: observation.packageName,
        exportPath: observation.exportPath,
        canonicalReference: item.canonicalReference.toString(),
      };
      const references = await modelReferences(item, model, identity, context);
      output.push({
        identity,
        displayName: item.displayName,
        kind: item.kind,
        parentReference: item.parent?.canonicalReference.toString() ?? "",
        parentKind: item.parent?.kind ?? "None",
        excerpt: item.excerpt.text,
        isExported: exported,
        public: isPublic,
        references,
      });
    }
    for (const member of item.members) {
      await walk(member, isPublic);
    }
  }
  await walk(pkg, true);
  // The model resolver can fail for a modeled hidden namespace member. Exact opaque
  // identities in this one export-path model provide a bounded local binding.
  return output.map((item) => ({
    ...item,
    references: item.references.map((reference): AuditReference => {
      if (reference.resolution !== "unresolved") {
        return reference;
      }
      const candidates = output.filter(
        (candidate) => candidate.identity.canonicalReference === reference.canonicalReference,
      );
      return candidates.length === 1
        ? { ...reference, resolution: "local", target: candidates[0]!.identity }
        : candidates.length > 1
          ? { ...reference, resolution: "ambiguous" }
          : reference;
    }),
  }));
}
