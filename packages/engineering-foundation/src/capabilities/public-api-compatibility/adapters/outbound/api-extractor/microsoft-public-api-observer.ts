import { pinnedCompiler, compilerPath, compilerLibraryRoot, tsdocBasePath, pinnedTsdocConfig } from "./load-pinned-audit-sdk.js";
import { bindAuditCompilerReferences } from "./audit-compiler-bindings.js";
import { stagePublicApiAudit, type AuditInputStage } from "../filesystem/stage-public-api-audit.js";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Extractor } from "@microsoft/api-extractor";
import { ApiDeclaredItem, ExcerptTokenKind, ApiExportedMixin, ApiReleaseTagMixin, ReleaseTag, ApiModel, type ApiItem } from "@microsoft/api-extractor-model";
import type { PinnedAuditCompiler, AuditCompilerProgram, AuditCompilerDiagnostic } from "./pinned-audit-compiler.js";
import type { AuditPackageInput } from "../../../contract/public-api-audit.js";
import type { PublicApiObserver } from "../../../application/ports/public-api-observer.js";
import { PUBLIC_API_AUDIT_PROFILE, type AuditDeclaration, type AuditDiagnostic, type AuditObservation, type AuditReference } from "../../../application/model/public-api-observation.js";
import { assertNotCancelled } from "../../../application/policies/public-api-evidence-errors.js";
import { auditDigest, auditInputPath, auditRelativePath, remapAuditStagePath, AUDIT_MAX_BYTES, AUDIT_MAX_FILES,auditPackagePolicy } from "../filesystem/public-api-audit-inputs.js";
import { mapReleasedBaseline } from "../filesystem/public-api-baseline-mapper.js";
import { preparePublicApiExtractor, invokePublicApiExtractor } from "./prepare-public-api-extractor.js";

const require = createRequire(import.meta.url);
const compiler = pinnedCompiler as PinnedAuditCompiler;
const BUILTINS = new Set(["AbortSignal", "Error", "Extract", "NoInfer", "Promise", "Readonly", "Record", "Uint8Array"]);
function compilerDiagnostic(diagnostic: AuditCompilerDiagnostic): AuditDiagnostic {
  const line = diagnostic.file !== undefined && diagnostic.start !== undefined
    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : undefined;
  return { source: "compiler", id: `TS${diagnostic.code}`,
    severity: compiler.DiagnosticCategory[diagnostic.category]?.toLowerCase() ?? "unknown",
    text: compiler.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    ...(diagnostic.file === undefined ? {} : { file: diagnostic.file.fileName }),
    ...(line === undefined ? {} : { line }) };
}
function libraryFile(path: string): boolean {
  const resolved = realpathSync(path);
  return dirname(resolved) === compilerLibraryRoot && /^lib\..*\.d\.ts$/u.test(basename(resolved));
}
function toolchainIdentity(): string {
  const modules = [require.resolve("@microsoft/api-extractor"), require.resolve("@microsoft/api-extractor-model"), compilerPath];
  const modelManifest = JSON.parse(readFileSync(join(dirname(dirname(require.resolve("@microsoft/api-extractor-model"))), "package.json"), "utf8")) as { readonly version: string };
  return JSON.stringify({ extractor: Extractor.version, model: modelManifest.version, compiler: compiler.version,
    tsdocBaseDigest: auditDigest(readFileSync(tsdocBasePath)), modules: modules.map((path) => ({ digest: auditDigest(readFileSync(path)) })) });
}
function builtin(reference: string | null, program: AuditCompilerProgram): AuditReference["library"] | undefined {
  const match = /^!([A-Za-z][A-Za-z0-9]*):(?:interface|type|var)$/u.exec(reference ?? "");
  const name = match?.[1];
  if (name === undefined || !BUILTINS.has(name)) {return;}
  const checker = program.getTypeChecker();
  const identities = new Set<string>();
  let found = false;
  // Every declaration source must bind this name exclusively to actual compiler libs.
  // This rejects local shadowing and merged global augmentations conservatively.
  for (const source of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(source)) {continue;}
    const symbol = checker.getSymbolsInScope(source, compiler.SymbolFlags.Type | compiler.SymbolFlags.Value).find((candidate) => candidate.name === name);
    if (symbol === undefined || symbol.declarations === undefined || symbol.declarations.length === 0) {return;}
    found = true;
    for (const declaration of symbol.declarations) {
      const file = declaration.getSourceFile();
      if (!program.isSourceFileDefaultLibrary(file) || !libraryFile(file.fileName)) {return;}
      identities.add(`${basename(file.fileName)}:${auditDigest(file.text)}`);
    }
  }
  return found ? { symbol: name, declarations: [...identities].toSorted() } : undefined;
}
function readModel(modelPath: string, observation: Pick<AuditObservation, "subject" | "packageName"> & { readonly exportPath: string }, program: AuditCompilerProgram, historical = false): AuditDeclaration[] {
  const model = new ApiModel();
  const pkg = model.loadPackage(modelPath);
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
          const library = target === undefined ? builtin(reference?.toString() ?? null, program) : undefined;
          return { text: token.text, canonicalReference: reference?.toString() ?? null,
            resolution: target !== undefined ? "local" : library !== undefined ? "verified-external-library" : "unresolved",
            ...(target === undefined ? {} : { target: { ...identity, canonicalReference: target.canonicalReference.toString() } }),
            ...(library === undefined ? {} : { library }) };
        }) });
    }
    for (const member of item.members) {walk(member, isPublic);}
  }
  walk(pkg, true);
  // The SDK resolver can fail for a modeled hidden namespace member. Exact opaque
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

async function prepareCompiler(context: ObservationContext, outputRoot: string, diagnostics: AuditDiagnostic[], configFiles: Map<string, string>) {
  const { input, allowed, pkg, entry } = context;
  const configPath = await auditInputPath(input.consumerRoot, pkg.tsconfigPath);
  const readConfig = (path: string): string | undefined => {
    const normalized = resolve(path);
    if (!allowed.has(normalized)) {throw new Error(`Undeclared configuration dependency: ${relative(input.consumerRoot, path)}.`);}
    const text = readFileSync(normalized, "utf8");
    if (auditDigest(text) !== allowed.get(normalized)) {throw new Error("Configuration digest mismatch.");}
    configFiles.set(normalized, auditDigest(text));
    return text;
  };
  const config = compiler.readConfigFile(configPath, readConfig);
  if (config.error !== undefined) {diagnostics.push(compilerDiagnostic(config.error));}
  const parsed = compiler.parseJsonConfigFileContent(config.config, {
    useCaseSensitiveFileNames: true, readFile: readConfig,
    fileExists: (path) => allowed.has(resolve(path)), readDirectory: () => { throw new Error("Audit requires explicit tsconfig files; glob discovery unsupported."); }
  }, dirname(configPath), undefined, configPath);
  diagnostics.push(...parsed.errors.map(compilerDiagnostic));
  if (parsed.options.plugins !== undefined || parsed.projectReferences !== undefined) {throw new Error("Compiler plugins and project references are outside the audit boundary.");}
  if (parsed.options.skipLibCheck === true || parsed.options.skipDefaultLibCheck === true || parsed.options.noCheck === true) {throw new Error("Compiler diagnostic suppression is unsupported for audit admission.");}
  for (const path of parsed.fileNames) {if (!allowed.has(resolve(path))) {throw new Error("Undeclared compiler root.");}}
  const options = { ...parsed.options };
  delete options["outDir"];
  delete options["declarationDir"];
  // The compiler host owns every filesystem observation used in resolution. It
  // exposes only declared bytes and actual pinned libraries, never ambient files.
  const host = compiler.createCompilerHost(options);
  const directories = new Set<string>();
  for (const path of allowed.keys()) {
    let directory = dirname(path);
    while (directory !== dirname(directory)) { directories.add(directory); directory = dirname(directory); }
  }
  const readable = (path: string): boolean => allowed.has(resolve(path)) ||
    (dirname(resolve(path)) === compilerLibraryRoot && /^lib\..*\.d\.ts$/u.test(basename(path)) && existsSync(path) && libraryFile(path));
  host.fileExists = readable;
  host.readFile = (path) => {
    if (!readable(path)) {return;}
    const text = readFileSync(path, "utf8");
    if (allowed.has(resolve(path)) && auditDigest(text) !== allowed.get(resolve(path))) {throw new Error("Compiler host input digest mismatch.");}
    if (basename(path) === "package.json") {configFiles.set(resolve(path), auditDigest(text));}
    return text;
  };
  host.directoryExists = (path) => directories.has(resolve(path)) || resolve(path) === compilerLibraryRoot;
  host.getDirectories = (path) => [...directories].filter((directory) => dirname(directory) === resolve(path)).map((directory) => basename(directory));
  host.realpath = (path) => resolve(path);
  host.getCurrentDirectory = () => input.consumerRoot;
  const roots = [...new Set([...parsed.fileNames, ...(entry === undefined ? [] : [resolve(input.consumerRoot, entry.declarationEntryPoint)])])];
  const program = compiler.createProgram(roots, options, host);
  if (entry === undefined) {return { program, invocation: undefined };}

  const modelPath = join(outputRoot, "surface.api.json");
  const extractorConfig = preparePublicApiExtractor({ packageRoot: dirname(await auditInputPath(input.consumerRoot, pkg.manifestPath)), manifestPath: await auditInputPath(input.consumerRoot, pkg.manifestPath), entryPointPath: await auditInputPath(input.consumerRoot, entry.declarationEntryPoint), tsconfigPath: configPath, apiJsonPath: modelPath, includeForgottenExports: true, untrimmedObservation: true, tsdocConfigFile: pinnedTsdocConfig() });
  // CompilerState's public contract is the program. Supplying that contract
  // avoids its unrestricted factory and keeps diagnostics and extraction on one program.
  const state = { program };
  return { program, invocation: { state, extractorConfig, modelPath } };
}

function validateCompilerSources(program: AuditCompilerProgram, context: ObservationContext): void {
  const { input, allowed } = context;
  let bytes = 0;
  for (const source of program.getSourceFiles()) {
    bytes += Buffer.byteLength(source.text);
    if (program.getSourceFiles().length > AUDIT_MAX_FILES || bytes > AUDIT_MAX_BYTES) {throw new Error("Compiler input budget exhausted.");}
    if (!source.isDeclarationFile) {throw new Error("Only prepared declarations are supported.");}
    if (!libraryFile(source.fileName) && allowed.get(resolve(source.fileName)) !== auditDigest(source.text)) {throw new Error(`Compiler input outside verified subject: ${source.fileName}.`);}
    for (const statement of source.statements) {
      const imported = statement.moduleSpecifier;
      if (imported?.text === undefined || imported.text.startsWith(".")) {continue;}
      const symbol = program.getTypeChecker().getSymbolAtLocation(imported);
      if (symbol === undefined) {continue;} // Independent diagnostics retain unresolved modules.
      const universe = input.declarations.resolutionUniverse.find((candidate) => `${candidate.packageName}${candidate.exportPath === "." ? "" : candidate.exportPath.slice(1)}` === imported.text);
      if (universe === undefined || symbol.declarations?.length !== 1 ||
          resolve(symbol.declarations[0]!.getSourceFile().fileName) !== resolve(input.consumerRoot, universe.declarationPath)) {
        throw new Error("Module binding is outside the explicit same-subject universe.");
      }

    }
  }
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
  const outputRoot = realpathSync(await mkdtemp(join(tmpdir(), "foundation-public-api-audit-")));
  const stageRoot = join(outputRoot, "evidence");
  let effectiveContext = context;
  let stage: AuditInputStage | undefined;
  const diagnostics: AuditDiagnostic[] = [];
  const unsupported: string[] = [];
  const configFiles = new Map<string, string>();
  let program: AuditCompilerProgram | undefined;
  let compilerOptions: Readonly<Record<string, unknown>> = {};
  let invocation: AuditObservation["invocation"] = { outcome: "not-invoked", succeeded: false, errorCount: null, warningCount: null };
  let collected = false;
  let modelPresent = false;
  let modelDigest: string | undefined;
  let items: AuditDeclaration[] = [];
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
    const prepared = await prepareCompiler(effectiveContext, outputRoot, diagnostics, configFiles);
    program = prepared.program;
    const { configFilePath: _configPath, ...effectiveOptions } = program.getCompilerOptions();
    compilerOptions = effectiveOptions;
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {unsupported.push("compiler-configuration-errors");}
    diagnostics.push(...compiler.getPreEmitDiagnostics(program).map(compilerDiagnostic));
    collected = true;
    validateCompilerSources(program, effectiveContext);
    if (prepared.invocation !== undefined && entry !== undefined) {
      const { state, extractorConfig, modelPath } = prepared.invocation;
      try {
        const result = invokePublicApiExtractor(extractorConfig, state, (message) => {
          diagnostics.push({ source: "extractor", id: message.messageId, severity: message.logLevel, text: message.text.replaceAll(outputRoot, "<audit-model-output>"),
            ...(message.sourceFilePath === undefined ? {} : { file: message.sourceFilePath }),
            ...(message.sourceFileLine === undefined ? {} : { line: message.sourceFileLine }) });
          message.handled = true;
        });
        invocation = { outcome: "completed", succeeded: result.succeeded, errorCount: result.errorCount, warningCount: result.warningCount };
      } catch (error) {
        invocation = { outcome: "exception", succeeded: false, errorCount: null, warningCount: null, exception: String(error).replaceAll(outputRoot, "<audit-model-output>") };
      }
      try {
        const modelBytes = await readFile(modelPath);
        modelPresent = true;
        modelDigest = auditDigest(modelBytes);
        if (modelBytes.length > AUDIT_MAX_BYTES) {throw new Error("Audit model byte budget exhausted.");}
        items = readModel(modelPath, { subject: input.subject, packageName: pkg.packageName, exportPath: entry.exportPath }, program);
        bindAuditCompilerReferences({ compiler, program, root: stage.root, declarations: input.declarations, pkg, items, bindings: context.dependencyBindings });
        validateModelExports(program, resolve(stage.root, entry.declarationEntryPoint), items);
        storedSurface = mapReleasedBaseline({ schemaVersion: 1, packageName: pkg.packageName, packageVersion: pkg.packageVersion,
          extractorVersion: Extractor.version, entrypoints: [{ exportPath: entry.exportPath, items: readModel(modelPath, { subject: input.subject, packageName: pkg.packageName, exportPath: entry.exportPath }, program, true).map((item) => ({
            canonicalReference: item.identity.canonicalReference, kind: item.kind, parentKind: item.parentKind, parentReference: item.parentReference,
            signature: item.excerpt.replaceAll("\r\n", "\n").trim() || (item.kind === "Namespace" ? `namespace ${item.displayName}` : "")
          })).toSorted((a, b) => a.canonicalReference < b.canonicalReference ? -1 : a.canonicalReference > b.canonicalReference ? 1 : 0) }] }, auditPackagePolicy(pkg));
      } catch (error) { unsupported.push(`model-unavailable: ${String(error).replaceAll(outputRoot, "<audit-model-output>")}`); }
    } else {
      storedSurface = mapReleasedBaseline({ schemaVersion: 1, packageName: pkg.packageName, packageVersion: pkg.packageVersion,
        extractorVersion: Extractor.version, entrypoints: [] }, auditPackagePolicy(pkg));
    }
    await revalidateObservationInputs(effectiveContext, metadataPresence, program);
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
    toolchain: toolchainIdentity(), normalizationProfile: PUBLIC_API_AUDIT_PROFILE,
    compilerEnvironment: compilerEnvironment(compilerOptions, effectiveContext), compilerOptions: restoreStagePaths(compilerOptions, stageRoot, input.consumerRoot),
    configurationDependencies: [...configFiles].map(([path, digest]) => fileIdentity(path, digest)),
    sourceFiles: program?.getSourceFiles().map((source) => fileIdentity(source.fileName, auditDigest(source.text))) ?? [],
    externalDeclarations: program?.getSourceFiles().filter((source) => program.isSourceFileDefaultLibrary(source)).map((source) => ({ path: basename(source.fileName), digest: auditDigest(source.text) })) ?? [],
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
    if (Extractor.version !== "7.58.12" || compiler.version !== "5.9.3" || (JSON.parse(readFileSync(join(dirname(dirname(require.resolve("@microsoft/api-extractor-model"))), "package.json"), "utf8")) as { readonly version: string }).version !== "7.33.10") {throw new Error("Unsupported audit toolchain: require Extractor 7.58.12 and its TypeScript 5.9.3.");}
    const input = { ...request, consumerRoot: realpathSync(request.consumerRoot) };
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
    // Extractor also reads enclosing package metadata. Declare and digest every
    // existing ancestor manifest, including nested and outside-root manifests;
    // record absent paths so a concurrent creation cannot go unnoticed.
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

function validateModelExports(program: AuditCompilerProgram, entryPoint: string, items: readonly AuditDeclaration[]): void {
        const entrySource = program.getSourceFile(entryPoint);
        const moduleSymbol = entrySource === undefined ? undefined : program.getTypeChecker().getSymbolAtLocation(entrySource);
        if (moduleSymbol === undefined) {throw new Error("Unsupported declaration entrypoint module binding.");}
        const exports = program.getTypeChecker().getExportsOfModule(moduleSymbol);
        for (const exported of exports) {
          if (!items.some((item) => item.public && item.parentKind === "EntryPoint" && item.displayName === exported.name)) {
            throw new Error(`Unsupported model omission for compiler export: ${exported.name}.`);
          }
        }
        if (items.some((item) => item.public && item.kind !== "Namespace" && !item.excerpt.trim())) {throw new Error("Empty historical declaration signature.");}

}

function recordMetadataDigest(manifest: string, allowed: ReadonlyMap<string, string>, configFiles: Map<string, string>): void {
  if (!allowed.has(manifest)) { throw new Error(`Undeclared resolution metadata: ${manifest}.`); }
  const digest = auditDigest(readFileSync(manifest));
  if (allowed.get(manifest) !== digest) { throw new Error(`Undeclared or changed resolution metadata: ${manifest}.`); }
  configFiles.set(manifest, digest);
}

async function revalidateObservationInputs(context: ObservationContext, metadataPresence: ReadonlyMap<string, boolean>, program: AuditCompilerProgram): Promise<void> {
  const { input, allowed } = context;
    for (const [path, present] of metadataPresence) {if (existsSync(path) !== present) {throw new Error("Resolution metadata changed during observation.");}}
    for (const [path, digest] of allowed) {
      await auditInputPath(input.consumerRoot, relative(input.consumerRoot, path).split(sep).join("/"));
      if (auditDigest(await readFile(path)) !== digest) {throw new Error("Audit input changed during observation.");}
    }
    for (const source of program.getSourceFiles()) {if (auditDigest(await readFile(source.fileName)) !== auditDigest(source.text)) {throw new Error("Compiler source changed during observation.");}}
}

function restoreStagePaths<T>(value: T, stageRoot: string, inputRoot: string): T {
  return JSON.parse(JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "string" ? remapAuditStagePath(entry, stageRoot, inputRoot) : entry)) as T;
}
