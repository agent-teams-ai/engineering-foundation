/**
 * The finite public TypeScript 5.9 Program API consumed by the observation adapter.
 * Foundation's own TypeScript 7 build tool no longer exports the legacy compiler
 * API types. These structural views describe only the pinned Extractor compiler;
 * they neither load another compiler nor expose a general verification service.
 */
export interface AuditCompilerNode {
  readonly kind: number;
  readonly text?: string;
  readonly name?: AuditCompilerNode;
  readonly parent?: AuditCompilerNode;
  readonly moduleSpecifier?: AuditCompilerNode;
  readonly argument?: AuditCompilerNode;
  readonly literal?: AuditCompilerNode;
  readonly expression?: AuditCompilerNode;
  readonly moduleReference?: AuditCompilerNode;
  readonly members?: readonly AuditCompilerNode[];
  readonly body?: AuditCompilerNode;
  getSourceFile(): AuditCompilerSourceFile;
}
interface AuditCompilerSourceFile extends AuditCompilerNode {
  readonly statements: readonly AuditCompilerNode[];
  readonly fileName: string;
  readonly text: string;
  readonly isDeclarationFile: boolean;
  getLineAndCharacterOfPosition(position: number): { readonly line: number };
}
interface AuditCompilerSymbol {
  readonly name: string;
  readonly declarations?: readonly AuditCompilerNode[];
}
export interface AuditCompilerProgram {
  getSourceFile(path: string): AuditCompilerSourceFile | undefined;
  getSourceFiles(): readonly AuditCompilerSourceFile[];
  getCompilerOptions(): Readonly<Record<string, unknown>>;
  isSourceFileDefaultLibrary(source: AuditCompilerSourceFile): boolean;
  getTypeChecker(): {
    getSymbolAtLocation(node: unknown): AuditCompilerSymbol | undefined;
    getExportsOfModule(symbol: AuditCompilerSymbol): readonly AuditCompilerSymbol[];
    getSymbolsInScope(source: AuditCompilerSourceFile, flags: number): readonly AuditCompilerSymbol[];
  };
}
export interface AuditCompilerDiagnostic {
  readonly code: number;
  readonly category: number;
  readonly messageText: unknown;
  readonly file?: AuditCompilerSourceFile;
  readonly start?: number;
}
export interface PinnedAuditCompiler {
  readonly SyntaxKind: Readonly<Record<string, number>>;
  forEachChild(node: AuditCompilerNode, visit: (node: AuditCompilerNode) => void): void;
  readonly version: string;
  readonly sys: unknown;
  readonly DiagnosticCategory: Readonly<Record<number, string>>;
  readonly SymbolFlags: { readonly Type: number; readonly Value: number };
  flattenDiagnosticMessageText(message: unknown, newline: string): string;
  readConfigFile(path: string, readFile: (path: string) => string | undefined): {
    readonly config: unknown; readonly error?: AuditCompilerDiagnostic;
  };
  parseJsonConfigFileContent(config: unknown, host: {
    readonly useCaseSensitiveFileNames: boolean;
    readFile(path: string): string | undefined;
    fileExists(path: string): boolean;
    readDirectory(path: string): readonly string[];
  }, basePath: string, options: undefined, configPath: string): {
    readonly options: Readonly<Record<string, unknown>>;
    readonly fileNames: readonly string[];
    readonly errors: readonly AuditCompilerDiagnostic[];
    readonly projectReferences?: unknown;
  };
  createCompilerHost(options: Readonly<Record<string, unknown>>): AuditCompilerHost;
  createProgram(rootNames: readonly string[], options: Readonly<Record<string, unknown>>, host?: AuditCompilerHost): AuditCompilerProgram;
  getPreEmitDiagnostics(program: AuditCompilerProgram): readonly AuditCompilerDiagnostic[];
  preProcessFile(text: string): { readonly importedFiles: readonly { readonly fileName: string }[] };
  resolveModuleName(name: string, source: string, options: Readonly<Record<string, unknown>>, host: unknown): {
    readonly resolvedModule?: { readonly resolvedFileName: string };
  };
}

interface AuditCompilerHost {
  readFile(path: string): string | undefined;
  fileExists(path: string): boolean;
  directoryExists?(path: string): boolean;
  getDirectories?(path: string): string[];
  realpath?(path: string): string;
  getCurrentDirectory(): string;
}
