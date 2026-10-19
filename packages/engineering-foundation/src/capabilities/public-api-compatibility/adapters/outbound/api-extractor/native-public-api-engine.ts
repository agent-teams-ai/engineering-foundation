import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { API, DiagnosticCategory, type Checker, type Diagnostic, type Emitter, type Program, type Project, type Snapshot } from "typescript/unstable/async";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { assertNotCancelled, publicApiInputError } from "../../../application/policies/public-api-evidence-errors.js";
import { nativeLibraryDirectory } from "./load-pinned-audit-sdk.js";
export { NATIVE_EXTRACTOR_VERSION, nativeCompilerPath, nativeLibraryDirectory } from "./load-pinned-audit-sdk.js";

const MAX_FILES = 20_000;
const MAX_BYTES = 128 * 1024 * 1024;

export function nativeLibraryFiles(): ReadonlyMap<string, string> {
  return new Map(readdirSync(nativeLibraryDirectory).filter(name => /^lib\..*\.d\.ts$/u.test(name)).map(name => {
    const path = join(nativeLibraryDirectory, name);
    return [path, readFileSync(path, "utf8")];
  }));
}

export interface NativePublicApiDiagnostic {
  readonly source: "compiler" | "extractor";
  readonly id: string;
  readonly severity: string;
  readonly text: string;
  readonly file?: string;
  readonly line?: number;
}

export interface NativePublicApiContext {
  readonly api: API;
  readonly snapshot: Snapshot;
  readonly project: Project;
  readonly program: Program;
  readonly checker: Checker;
  readonly emitter: Emitter;
  readonly config: Awaited<ReturnType<API["parseConfigFile"]>>;
  readonly files: ReadonlyMap<string, string>;
  readonly readFiles: ReadonlySet<string>;
  readonly signal?: AbortSignal;
}

export function nativeDiagnostic(diagnostic: Diagnostic, files?: ReadonlyMap<string, string>): NativePublicApiDiagnostic {
  const source = diagnostic.fileName === undefined ? undefined : files?.get(resolve(diagnostic.fileName).replaceAll("\\", "/"));
  const text = [diagnostic.text, ...(diagnostic.messageChain ?? []).map(item => nativeDiagnostic(item).text)].join("\n");
  return {
    source: "compiler", id: `TS${diagnostic.code}`,
    severity: Object.hasOwn(DiagnosticCategory, diagnostic.category) ? DiagnosticCategory[diagnostic.category].toLowerCase() : "unknown",
    text,
    ...(diagnostic.fileName === undefined ? {} : { file: diagnostic.fileName }),
    ...(source === undefined || diagnostic.pos < 0 ? {} : { line: source.slice(0, diagnostic.pos).split("\n").length })
  };
}

export async function nativeCompilerDiagnostics(context: NativePublicApiContext): Promise<readonly NativePublicApiDiagnostic[]> {
  const { program } = context;
  const diagnostics = [
    ...await program.getConfigFileParsingDiagnostics(), ...await program.getProgramDiagnostics(),
    ...await program.getSyntacticDiagnostics(), ...await program.getBindDiagnostics(),
    ...await program.getGlobalDiagnostics(), ...await program.getSemanticDiagnostics(),
    ...await program.getSuggestionDiagnostics(), ...await program.getDeclarationDiagnostics()
  ];
  const unique = new Map(diagnostics.map(item => [JSON.stringify(item), nativeDiagnostic(item, context.files)]));
  return [...unique.values()];
}

/** One closed native compiler session. Undefined callback results would allow the
 * native server's real-filesystem fallback, so absent paths return explicit null. */
export async function withNativePublicApiProject<T>(input: {
  readonly cwd: string;
  readonly configPath: string;
  readonly files: ReadonlyMap<string, string>;
  readonly declarationEntryPoint?: string;
  readonly signal?: AbortSignal;
}, inspect: (context: NativePublicApiContext) => T | Promise<T>): Promise<T> {
  const { cwd, configPath: inputConfigPath, declarationEntryPoint, signal } = input;
  assertNotCancelled(signal);
  const files = new Map([...input.files, ...nativeLibraryFiles()].map(([path, text]) => [resolve(path).replaceAll("\\", "/"), text]));
  const bytes = [...files.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  if (files.size > MAX_FILES || bytes > MAX_BYTES) {
    publicApiInputError("PUBLIC_API_PATH_INVALID", "Public API native compiler input exceeds its file or byte budget.", "public-api-extraction");
  }
  const virtual = createVirtualFileSystem(Object.fromEntries(files));
  const readFile = virtual.readFile;
  const entries = virtual.getAccessibleEntries;
  const writeFile = virtual.writeFile;
  if (readFile === undefined || entries === undefined || writeFile === undefined) { throw new Error("Native virtual filesystem is incomplete."); }
  const readFiles = new Set<string>();
  virtual.readFile = path => {
    const text = readFile(path);
    if (text !== undefined && text !== null) { readFiles.add(resolve(path)); }
    return text ?? null;
  };
  virtual.getAccessibleEntries = path => entries(path) ?? { files: [], directories: [] };
  const api = new API({ cwd, fs: virtual });
  try {
    const config = await api.parseConfigFile(inputConfigPath);
    let configPath = inputConfigPath;
    if (declarationEntryPoint !== undefined) {
      // Like the prior compiler adapter, analyze declarations rather than the
      // consumer's source roots. Null resets inherited output redirections.
      configPath = join(dirname(inputConfigPath), ".foundation-native-api.tsconfig.json").replaceAll("\\", "/");
      const content = JSON.stringify({ extends: inputConfigPath, files: [...new Set([...config.fileNames.filter(path => /\.d\.[cm]?ts$/u.test(path)), declarationEntryPoint])],
        include: [], exclude: [], compilerOptions: { outDir: null, declarationDir: null, rootDir: null, composite: false, noEmit: true, emitDeclarationOnly: false,
          noCheck: false, skipLibCheck: false, skipDefaultLibCheck: false } });
      writeFile(configPath, content);
      files.set(configPath, content);
    }
    const snapshot = await api.updateSnapshot({ openProjects: [configPath] });
    try {
      const project = snapshot.getProject(configPath);
      if (project === undefined) { throw new Error("Native public API compiler project is unavailable."); }
      const context: NativePublicApiContext = { api, snapshot, project, program: project.program, checker: project.checker, emitter: project.emitter, config, files, readFiles,
        ...(signal === undefined ? {} : { signal }) };
      assertNotCancelled(signal);
      return await inspect(context);
    } finally { await snapshot.dispose(); }
  } finally { await api.close(); }
}
