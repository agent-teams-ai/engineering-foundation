import { assertPinnedAuditSdk, auditToolchainIdentity, compilerLibraryRoot } from "./load-pinned-audit-sdk.js";
import { bindAuditCompilerReferences } from "./audit-compiler-bindings.js";
import { NATIVE_EXTRACTOR_VERSION, nativeCompilerDiagnostics, withNativePublicApiProject, type NativePublicApiContext } from "./native-public-api-engine.js";
import { createNativePublicApiModel } from "./native-public-api-model.js";
import { stagePublicApiAudit, type AuditInputStage } from "../filesystem/stage-public-api-audit.js";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { SymbolFlags } from "typescript/unstable/sync";
import type { SourceFile } from "typescript/unstable/ast";
import { ApiDeclaredItem, ExcerptTokenKind, ApiExportedMixin, ApiReleaseTagMixin, ReleaseTag, type ApiModel, type ApiPackage, type ApiItem } from "@microsoft/api-extractor-model";
import type { AuditPackageInput } from "../../../contract/public-api-audit.js";
import type { PublicApiObserver } from "../../../application/ports/public-api-observer.js";
import { PUBLIC_API_AUDIT_PROFILE, type AuditDeclaration, type AuditDiagnostic, type AuditObservation, type AuditReference } from "../../../application/model/public-api-observation.js";
import { assertNotCancelled } from "../../../application/policies/public-api-evidence-errors.js";
import { auditDigest, auditInputPath, auditRelativePath, remapAuditStagePath, AUDIT_MAX_BYTES, AUDIT_MAX_FILES, auditPackagePolicy } from "../filesystem/public-api-audit-inputs.js";
import { mapReleasedBaseline } from "../filesystem/public-api-baseline-mapper.js";

const BUILTINS = new Set(["AbortSignal", "Error", "Extract", "NoInfer", "Promise", "Readonly", "Record", "Uint8Array"]);
const normalized = (path: string): string => resolve(path).replaceAll("\\", "/");
function libraryFile(path: string): boolean {
  const resolved = realpathSync(path);
  return dirname(resolved) === compilerLibraryRoot && /^lib\..*\.d\.ts$/u.test(basename(resolved));
}
function nativeSources(context: NativePublicApiContext): readonly SourceFile[] {
  return context.program.getSourceFileNames().map(path => {
    const source = context.program.getSourceFile(path);
    if (source === undefined) { throw new Error("Native compiler source is unavailable."); }
    return source;
  });
}
function defaultLibrary(context: NativePublicApiContext, source: SourceFile): boolean {
  return context.program.getSourceFileMetadata(source.fileName)?.isDefaultLibrary === true;
}
function builtin(reference: string | null, context: NativePublicApiContext): AuditReference["library"] | undefined {
  const name = /^!([A-Za-z][A-Za-z0-9]*):(?:interface|type|var)$/u.exec(reference ?? "")?.[1];
  if (name === undefined || !BUILTINS.has(name)) { return; }
  const identities = new Set<string>();
  let found = false;
  // Every source must resolve this spelling exclusively to actual pinned libraries.
  // A local shadow or any merged augmentation prevents external-library admission.
  for (const source of nativeSources(context)) {
    if (defaultLibrary(context, source)) { continue; }
    const symbol = context.checker.resolveName(name, SymbolFlags.Type | SymbolFlags.Value, source);
    if (symbol === undefined || symbol.declarations.length === 0) { return; }
    found = true;
    for (const handle of symbol.declarations) {
      const declaration = handle.resolve(context.project);
      if (declaration === undefined) { return; }
      const file = declaration.getSourceFile();
      if (!defaultLibrary(context, file) || !libraryFile(file.fileName)) { return; }
      identities.add(`${basename(file.fileName)}:${auditDigest(file.text)}`);
    }
  }
  return found ? { symbol: name, declarations: [...identities].toSorted() } : undefined;
}

function readModel(model: ApiModel, pkg: ApiPackage, observation: Pick<AuditObservation, "subject" | "packageName"> & { readonly exportPath: string }, context: NativePublicApiContext, historical = false): AuditDeclaration[] {
  if (pkg.name !== observation.packageName || pkg.entryPoints.length !== 1) {throw new Error("Unsupported audit model package/entrypoint identity.");}
  const output: AuditDeclaration[] = [];
  function walk(item: ApiItem, parentPublic: boolean): void {
    if (output.length >= AUDIT_MAX_FILES) {throw new Error("Audit model node budget exhausted.");}
    // Historical production models trim internal containers and omit forgotten exports.
    if (historical && ApiReleaseTagMixin.isBaseClassOf(item) && item.releaseTag === ReleaseTag.Internal) {return;}
    const exported = ApiExportedMixin.isBaseClassOf(item) ? item.isExported : null;
    const isPublic = parentPublic && exported !== false;
    if (historical && !isPublic) {return;}
    if (item instanceof ApiDeclaredItem) {
      const identity = { subject: observation.subject, packageName: observation.packageName, exportPath: observation.exportPath, canonicalReference: item.canonicalReference.toString() };
      output.push({ identity, displayName: item.displayName, kind: item.kind,
        parentReference: item.parent?.canonicalReference.toString() ?? "", parentKind: item.parent?.kind ?? "None",
        excerpt: item.excerpt.text, isExported: exported, public: isPublic,
        references: item.excerpt.spannedTokens.filter((token) => token.kind === ExcerptTokenKind.Reference).map((token): AuditReference => {
          const reference = token.canonicalReference;
          const target = reference === undefined ? undefined : model.resolveDeclarationReference(reference, item).resolvedApiItem;
          const library = target === undefined ? builtin(reference?.toString() ?? null, context) : undefined;
          return { text: token.text, canonicalReference: reference?.toString() ?? null,
            resolution: target !== undefined ? "local" : library !== undefined ? "verified-external-library" : "unresolved",
            ...(target === undefined ? {} : { target: { ...identity, canonicalReference: target.canonicalReference.toString() } }),
            ...(library === undefined ? {} : { library }) };
        }) });
    }
    for (const member of item.members) {walk(member, isPublic);}
  }
  walk(pkg, true);
  // The model resolver can fail for a modeled hidden namespace member. Exact opaque
  // identities in this one export-path model provide a bounded local binding.
  return output.map((item) => ({ ...item, references: item.references.map((reference): AuditReference => {
    if (reference.resolution !== "unresolved") {return reference;}
    const candidates = output.filter((candidate) => candidate.identity.canonicalReference === reference.canonicalReference);
    return candidates.length === 1 ? { ...reference, resolution: "local", target: candidates[0]!.identity }
      : candidates.length > 1 ? { ...reference, resolution: "ambiguous" } : reference;
  }) }));
}


type ObserverInput = Parameters<PublicApiObserver["observe"]>[0];
interface ObservationContext {
  readonly input: ObserverInput;
  readonly allowed: ReadonlyMap<string, string>;
  readonly subjectRoot: string;
  readonly pkg: AuditPackageInput;
  readonly dependencyBindings: Map<AuditReference, string>;
  readonly entry: AuditPackageInput["entrypoints"][number] | undefined;
}
interface AuditConfiguration {
  readonly options: Readonly<Record<string, unknown>>;
  readonly roots: readonly string[] | undefined;
  readonly include: unknown;
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) { throw new Error("Unsupported audit compiler configuration object."); }
  return value as Record<string, unknown>;
}
function configDependency(path: string, specifier: string, files: ReadonlyMap<string, string>): string {
  const candidates: string[] = [];
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    const pathBase = resolve(dirname(path), specifier);
    candidates.push(pathBase, `${pathBase}.json`);
  } else {
    let directory = dirname(path);
    for (;;) {
      const pathBase = join(directory, "node_modules", specifier);
      candidates.push(pathBase, `${pathBase}.json`, join(pathBase, "tsconfig.json"));
      const parent = dirname(directory);
      if (parent === directory) { break; }
      directory = parent;
    }
  }
  const selected = candidates.find(candidate => files.has(normalized(candidate)));
  if (selected === undefined) { throw new Error(`Undeclared configuration dependency: ${specifier}.`); }
  return normalized(selected);
}
function prepareNativeFiles(context: ObservationContext, configFiles: Map<string, string>): { readonly configPath: string; readonly files: ReadonlyMap<string, string> } {
  const files = new Map<string, string>();
  for (const [path, digest] of context.allowed) {
    const text = readFileSync(path, "utf8");
    if (auditDigest(text) !== digest) { throw new Error("Compiler host input digest mismatch."); }
    files.set(normalized(path), text);
  }
  const configPath = normalized(join(context.input.consumerRoot, context.pkg.tsconfigPath));
  const configurations = new Map<string, Record<string, unknown>>();
  const visiting = new Set<string>();
  function readConfiguration(path: string): AuditConfiguration {
    if (visiting.has(path)) { throw new Error("Circular audit compiler configuration."); }
    visiting.add(path);
    const text = files.get(path);
    if (text === undefined) { throw new Error(`Undeclared configuration dependency: ${path}.`); }
    const errors: ParseError[] = [];
    const configuration = object(parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown);
    if (errors.length > 0) { throw new Error("Invalid audit compiler JSONC configuration."); }
    configurations.set(path, configuration);
    configFiles.set(resolve(path), auditDigest(text));
    const optionLayers: Readonly<Record<string, unknown>>[] = [];
    let roots: readonly string[] | undefined;
    let include: unknown;
    const extended = configuration["extends"];
    if (extended !== undefined) {
      const bases = typeof extended === "string" ? [extended] : extended;
      if (!Array.isArray(bases) || !bases.every((base): base is string => typeof base === "string")) { throw new Error("Unsupported audit compiler inheritance."); }
      for (const base of bases) {
        const inherited = readConfiguration(configDependency(path, base, files));
        optionLayers.push(inherited.options);
        roots = inherited.roots ?? roots;
        include = inherited.include ?? include;
      }
    }
    if (configuration["references"] !== undefined) { throw new Error("Compiler plugins and project references are outside the audit boundary."); }
    if (configuration["compilerOptions"] !== undefined) { optionLayers.push(object(configuration["compilerOptions"])); }
    if (configuration["files"] !== undefined) {
      const specified: unknown = configuration["files"];
      if (!Array.isArray(specified) || !specified.every((file): file is string => typeof file === "string")) { throw new Error("Unsupported audit compiler root files."); }
      roots = specified.map(file => normalized(resolve(dirname(path), file)));
    }
    include = configuration["include"] ?? include;
    visiting.delete(path);
    return { options: Object.fromEntries(optionLayers.flatMap(layer => Object.entries(layer))), roots, include };
  }
  const configuration = readConfiguration(configPath);
  if (configuration.options["plugins"] !== undefined) { throw new Error("Compiler plugins and project references are outside the audit boundary."); }
  if (configuration.options["skipLibCheck"] === true || configuration.options["skipDefaultLibCheck"] === true || configuration.options["noCheck"] === true) { throw new Error("Compiler diagnostic suppression is unsupported for audit admission."); }
  if (configuration.roots === undefined || (configuration.include !== undefined && (!Array.isArray(configuration.include) || configuration.include.length > 0))) { throw new Error("Audit requires explicit tsconfig files; glob discovery unsupported."); }
  for (const path of configuration.roots) { if (!context.allowed.has(resolve(path))) { throw new Error("Undeclared compiler root."); } }
  const raw = configurations.get(configPath)!;
  const rawOptions = raw["compilerOptions"] === undefined ? {} : object(raw["compilerOptions"]);
  const configuredLibraries = configuration.options["lib"];
  if (configuredLibraries !== undefined && (!Array.isArray(configuredLibraries) || !configuredLibraries.every((library): library is string => typeof library === "string"))) { throw new Error("Unsupported audit compiler libraries."); }
  const entryPoint = context.entry === undefined ? [] : [normalized(join(context.input.consumerRoot, context.entry.declarationEntryPoint))];
  files.set(configPath, JSON.stringify({ ...raw, files: [...new Set([...configuration.roots, ...entryPoint])], compilerOptions: {
    ...rawOptions, outDir: null, declarationDir: null,
    ...(configuredLibraries === undefined ? {} : { lib: [...configuredLibraries, ...(configuredLibraries.some(library => /^(?:lib\.)?dom(?:\.d\.ts)?$/iu.test(library)) ? [] : ["DOM"])] })
  } }));
  return { configPath, files };
}
function validateCompilerSources(native: NativePublicApiContext, context: ObservationContext): readonly SourceFile[] {
  const sources = nativeSources(native);
  let bytes = 0;
  for (const source of sources) {
    bytes += Buffer.byteLength(source.text);
    if (sources.length > AUDIT_MAX_FILES || bytes > AUDIT_MAX_BYTES) { throw new Error("Compiler input budget exhausted."); }
    if (!source.isDeclarationFile) { throw new Error("Only prepared declarations are supported."); }
    if (defaultLibrary(native, source)) {
      if (!libraryFile(source.fileName)) { throw new Error("Compiler library outside pinned native toolchain."); }
    } else if (context.allowed.get(resolve(source.fileName)) !== auditDigest(source.text)) { throw new Error(`Compiler input outside verified subject: ${source.fileName}.`); }
  }
  return sources;
}

function compilerEnvironment(options: Readonly<Record<string, unknown>>, context: ObservationContext): string {
  const { input, subjectRoot } = context;
  return JSON.stringify(options, (key, value: unknown) => {
    if (key === "configFile") {return;}
    if (typeof value === "string") {
      for (const candidate of input.declarations.packages) {
        const packageRoot = resolve(input.consumerRoot, dirname(candidate.manifestPath));
        const local = auditRelativePath(packageRoot, value);
        if (local !== undefined) {return `package:${candidate.packageName}/${local.split(sep).join("/")}`;}
      }
      const local = auditRelativePath(subjectRoot, value);
      if (local !== undefined) {return `<subject-root>/${local.split(sep).join("/")}`;}
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {return Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));}
    return value;
  });
}


async function observeEntrypoint(context: ObservationContext): Promise<AuditObservation> {
  const { input, allowed, pkg, entry } = context;
  assertNotCancelled(input.signal);
  const outputRoot = await realpath(await mkdtemp(join(tmpdir(), "foundation-public-api-audit-")));
  const stageRoot = join(outputRoot, "evidence");
  let effectiveContext = context;
  let stage: AuditInputStage | undefined;
  const diagnostics: AuditDiagnostic[] = [];
  const unsupported: string[] = [];
  const configFiles = new Map<string, string>();
  let compilerOptions: Readonly<Record<string, unknown>> = {};
  let invocation: AuditObservation["invocation"] = { outcome: "not-invoked", succeeded: false, errorCount: null, warningCount: null };
  let collected = false;
  let modelPresent = false;
  let modelDigest: string | undefined;
  let items: AuditDeclaration[] = [];
  let sources: readonly { readonly fileName: string; readonly text: string; readonly library: boolean }[] = [];
  let revalidated = false;
  let storedSurface: AuditObservation["storedSurface"];
  try {
    const metadataPresence = collectMetadataPresence(allowed, configFiles);
    stage = await stagePublicApiAudit(input.consumerRoot, allowed, stageRoot);
    const metadataDigests = [...configFiles];
    configFiles.clear();
    for (const [path, digest] of metadataDigests) { configFiles.set(join(stage.root, relative(input.consumerRoot, path)), digest); }
    effectiveContext = { ...context, input: { ...input, consumerRoot: stage.root }, allowed: stage.files,
      subjectRoot: join(stage.root, relative(input.consumerRoot, context.subjectRoot)) };
    const prepared = prepareNativeFiles(effectiveContext, configFiles);
    await withNativePublicApiProject({ cwd: stage.root, configPath: prepared.configPath, files: prepared.files,
      ...(input.signal === undefined ? {} : { signal: input.signal }) }, async native => {
      const { configFilePath: _configPath, ...options } = native.config.options;
      compilerOptions = options;
      diagnostics.push(...nativeCompilerDiagnostics(native));
      collected = true;
      const checkedSources = validateCompilerSources(native, effectiveContext);
      sources = checkedSources.map(source => ({ fileName: source.fileName, text: source.text, library: defaultLibrary(native, source) }));
      for (const path of native.readFiles) {
        if (basename(path) === "package.json" && effectiveContext.allowed.has(resolve(path))) { configFiles.set(resolve(path), auditDigest(readFileSync(path))); }
      }
      if (entry !== undefined) {
        const modelPath = join(outputRoot, "surface.api.json");
        try {
          if (diagnostics.some(diagnostic => diagnostic.source === "compiler" && diagnostic.severity === "error")) { throw new Error("Native public API extraction cannot model compiler errors."); }
          const result = createNativePublicApiModel(native, { packageName: pkg.packageName,
            entryPointPath: resolve(stage!.root, entry.declarationEntryPoint), includeForgottenExports: true, untrimmedObservation: true,
            referenceProjection: "declaration-graph" });
          diagnostics.push(...result.diagnostics.filter(diagnostic => diagnostic.source !== "compiler"));
          invocation = { outcome: "completed", succeeded: result.succeeded,
            errorCount: result.diagnostics.filter(diagnostic => diagnostic.severity === "error").length,
            warningCount: result.diagnostics.filter(diagnostic => diagnostic.severity === "warning").length };
          result.apiPackage.saveToJsonFile(modelPath, { toolPackage: "@agent-teams/engineering-foundation", toolVersion: NATIVE_EXTRACTOR_VERSION });
          try {
            const modelBytes = await readFile(modelPath);
            modelPresent = true;
            modelDigest = auditDigest(modelBytes);
            if (modelBytes.length > AUDIT_MAX_BYTES) { throw new Error("Audit model byte budget exhausted."); }
            items = readModel(result.model, result.apiPackage, { subject: input.subject, packageName: pkg.packageName, exportPath: entry.exportPath }, native);
            bindAuditCompilerReferences({ program: native.program, checker: native.checker, project: native.project,
              root: stage!.root, declarations: input.declarations, items, declarationBindings: result.declarationBindings, bindings: context.dependencyBindings });
            validateModelExports(native, resolve(stage!.root, entry.declarationEntryPoint), items);
            storedSurface = mapReleasedBaseline({ schemaVersion: 1, packageName: pkg.packageName, packageVersion: pkg.packageVersion,
              extractorVersion: NATIVE_EXTRACTOR_VERSION, entrypoints: [{ exportPath: entry.exportPath,
                items: readModel(result.model, result.apiPackage, { subject: input.subject, packageName: pkg.packageName, exportPath: entry.exportPath }, native, true).map(item => ({
                  canonicalReference: item.identity.canonicalReference, kind: item.kind, parentKind: item.parentKind, parentReference: item.parentReference,
                  signature: item.excerpt.replaceAll("\r\n", "\n").trim() || (item.kind === "Namespace" ? `namespace ${item.displayName}` : "")
                })).toSorted((a, b) => a.canonicalReference < b.canonicalReference ? -1 : a.canonicalReference > b.canonicalReference ? 1 : 0) }] }, auditPackagePolicy(pkg));
          } catch (error) { unsupported.push(`model-unavailable: ${String(error).replaceAll(outputRoot, "<audit-model-output>")}`); }
        } catch (error) {
          invocation = { outcome: "exception", succeeded: false, errorCount: null, warningCount: null,
            exception: String(error).replaceAll(outputRoot, "<audit-model-output>") };
        }
      } else {
        storedSurface = mapReleasedBaseline({ schemaVersion: 1, packageName: pkg.packageName, packageVersion: pkg.packageVersion,
          extractorVersion: NATIVE_EXTRACTOR_VERSION, entrypoints: [] }, auditPackagePolicy(pkg));
      }
      await revalidateObservationInputs(effectiveContext, metadataPresence, sources);
    });
    await stage.revalidate();
    revalidated = true;
  } catch (error) {
    unsupported.push(String(error));
  } finally {
    // Each owned-resource cleanup is independent; evidence survives either failure.
    try { await stage?.release(); }
    catch (error) { unsupported.push(`owned-resource-cleanup: permission-restore: ${outputRoot}: ${String(error)}`); }
    try { await rm(outputRoot, { recursive: true, force: true }); }
    catch (error) { unsupported.push(`owned-resource-cleanup: removal: ${outputRoot}: ${String(error)}`); }
  }
  assertNotCancelled(input.signal);
  const fileIdentity = (path: string, digest: string) => ({ path: relative(input.consumerRoot, remapAuditStagePath(path, stageRoot, input.consumerRoot)).split(sep).join("/"), digest });
  return { subject: input.subject, packageName: pkg.packageName, packageVersion: pkg.packageVersion, exportPath: entry?.exportPath ?? null, modelExpected: entry !== undefined,
    toolchain: auditToolchainIdentity(), normalizationProfile: PUBLIC_API_AUDIT_PROFILE,
    compilerEnvironment: compilerEnvironment(compilerOptions, effectiveContext), compilerOptions: restoreStagePaths(compilerOptions, stageRoot, input.consumerRoot),
    configurationDependencies: [...configFiles].map(([path, digest]) => fileIdentity(path, digest)),
    sourceFiles: sources.map(source => fileIdentity(source.fileName, auditDigest(source.text))),
    externalDeclarations: sources.filter(source => source.library).map(source => ({ path: basename(source.fileName), digest: auditDigest(source.text) })),
    ...(storedSurface === undefined ? {} : { storedSurface }),
    diagnostics: restoreStagePaths(diagnostics, stageRoot, input.consumerRoot), compilerDiagnosticsCollected: collected, invocation, modelPresent,
    ...(modelDigest === undefined ? {} : { modelDigest }), items, inputBytesRevalidated: revalidated, unsupported };
}

function resolveSubjectReferences(observations: readonly AuditObservation[], bindings: ReadonlyMap<AuditObservation, ReadonlyMap<AuditReference, string>>): readonly AuditObservation[] {
  return observations.map((observation) => ({ ...observation, items: observation.items.map((item) => ({ ...item,
      references: item.references.map((reference): AuditReference => {
        if (reference.resolution !== "unresolved") {return reference;}
        const candidates = observations.filter((candidate) => candidate.packageName !== observation.packageName && bindings.get(observation)?.get(reference) === JSON.stringify([candidate.packageName, candidate.exportPath])).flatMap((candidate) => candidate.items).filter((candidate) => candidate.identity.canonicalReference === reference.canonicalReference && candidate.public);
        return candidates.length === 1 ? { ...reference, resolution: "same-subject-dependency", target: candidates[0]!.identity }
          : candidates.length > 1 ? { ...reference, resolution: "ambiguous" } : reference;
      }) })) }));
}


export class MicrosoftPublicApiObserver implements PublicApiObserver {
  async observe(request: Parameters<PublicApiObserver["observe"]>[0]): Promise<readonly AuditObservation[]> {
    assertNotCancelled(request.signal);
    assertPinnedAuditSdk();
    // Match auditInputPath's native realpath: the JS sync variant can retain Windows 8.3 aliases.
    const input = { ...request, consumerRoot: await realpath(request.consumerRoot) };
    const expectedModels = input.declarations.packages.reduce((total, pkg) => total + Math.max(1, pkg.entrypoints.length), 0);
    if (expectedModels > 64 || input.declarations.files.length > AUDIT_MAX_FILES) {throw new Error("Audit subject exceeds the 64-model or input-file budget.");}
    const allowed = new Map<string, string>();
    for (const file of input.declarations.files) {allowed.set(await auditInputPath(input.consumerRoot, file.path), file.digest);}
    let subjectRoot = dirname([...allowed.keys()][0] ?? resolve(input.consumerRoot));
    for (const path of allowed.keys()) {
      while (path !== subjectRoot && !path.startsWith(`${subjectRoot}${sep}`)) {
        const parent = dirname(subjectRoot);
        if (parent === subjectRoot) {break;}
        subjectRoot = parent;
      }
    }
    const observations: AuditObservation[] = [];
    const bindings = new Map<AuditObservation, ReadonlyMap<AuditReference, string>>();
    let retainedBytes = 0;
    for (const pkg of input.declarations.packages.toSorted((a, b) => a.packageName.localeCompare(b.packageName))) {
      const entries = pkg.entrypoints.length === 0 ? [undefined] : pkg.entrypoints.toSorted((a, b) => a.exportPath.localeCompare(b.exportPath));
      for (const entry of entries) {
        const dependencyBindings = new Map<AuditReference, string>();
        const observation = await observeEntrypoint({ input, allowed, subjectRoot, pkg, entry, dependencyBindings });
        bindings.set(observation, dependencyBindings);
        retainedBytes += Buffer.byteLength(JSON.stringify(observation));
        if (retainedBytes > 64 * 1024 * 1024) {
          observations.push({ ...observation, unsupported: [...observation.unsupported, "subject-observation-byte-budget-exhausted"] });
          return resolveSubjectReferences(observations, bindings);
        }
        observations.push(observation);
      }
    }
    return resolveSubjectReferences(observations, bindings);
  }
}


function collectMetadataPresence(allowed: ReadonlyMap<string, string>, configFiles: Map<string, string>): Map<string, boolean> {
    // Compiler resolution observes enclosing package metadata. Declare and digest every
    // existing ancestor manifest, including nested and outside-root manifests;
    // record absence for best-effort mutation detection, not an atomic freeze.
    const metadataPresence = new Map<string, boolean>();
    for (const path of allowed.keys()) {
      let directory = dirname(path);
      for (;;) {
        const manifest = join(directory, "package.json");
        if (!metadataPresence.has(manifest)) {
          const present = existsSync(manifest);
          metadataPresence.set(manifest, present);
          if (present) { recordMetadataDigest(manifest, allowed, configFiles); }
        }
        const parent = dirname(directory);
        if (parent === directory) {break;}
        directory = parent;
      }
    }

  return metadataPresence;
}


function validateModelExports(context: NativePublicApiContext, entryPoint: string, items: readonly AuditDeclaration[]): void {
  const entrySource = context.program.getSourceFile(entryPoint);
  const moduleSymbol = entrySource === undefined ? undefined : context.checker.getSymbolAtLocation(entrySource);
  if (moduleSymbol === undefined) { throw new Error("Unsupported declaration entrypoint module binding."); }
  for (const exported of context.checker.getExportsOfModule(moduleSymbol)) {
    if (!items.some(item => item.public && item.parentKind === "EntryPoint" && item.displayName === exported.name)) { throw new Error(`Unsupported model omission for compiler export: ${exported.name}.`); }
  }
  if (items.some(item => item.public && item.kind !== "Namespace" && !item.excerpt.trim())) { throw new Error("Empty historical declaration signature."); }
}

function recordMetadataDigest(manifest: string, allowed: ReadonlyMap<string, string>, configFiles: Map<string, string>): void {
  if (!allowed.has(manifest)) { throw new Error(`Undeclared resolution metadata: ${manifest}.`); }
  const digest = auditDigest(readFileSync(manifest));
  if (allowed.get(manifest) !== digest) { throw new Error(`Undeclared or changed resolution metadata: ${manifest}.`); }
  configFiles.set(manifest, digest);
}


async function revalidateObservationInputs(context: ObservationContext, metadataPresence: ReadonlyMap<string, boolean>, sources: readonly { readonly fileName: string; readonly text: string }[]): Promise<void> {
  const { input, allowed } = context;
  for (const [path, present] of metadataPresence) { if (existsSync(path) !== present) { throw new Error("Resolution metadata changed during observation."); } }
  for (const [path, digest] of allowed) {
    await auditInputPath(input.consumerRoot, relative(input.consumerRoot, path).split(sep).join("/"));
    if (auditDigest(await readFile(path)) !== digest) { throw new Error("Audit input changed during observation."); }
  }
  for (const source of sources) { if (auditDigest(await readFile(source.fileName)) !== auditDigest(source.text)) { throw new Error("Compiler source changed during observation."); } }
}

function restoreStagePaths<T>(value: T, stageRoot: string, inputRoot: string): T {
  return JSON.parse(JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "string" ? remapAuditStagePath(entry, stageRoot, inputRoot) : entry)) as T;
}
