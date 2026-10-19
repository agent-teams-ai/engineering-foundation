import * as typescript from "typescript";
import * as ast from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API, ModuleKind, type Project } from "typescript/unstable/async";

import { inspectNativePackageDomain, isOwnPackageReference, nativePackageFailure, ownRuntimeTarget, type NativePackageDomain } from "./native-package-types-domain.ts";

export interface NativePackageTypeQualification {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly compilerVersion: "7.0.2";
  readonly modes: readonly ["node16-esm", "bundler"];
  readonly typedEntrypoints: number;
  readonly codeFiles: number;
  readonly ownImports: number;
}

const workspace = "/native-package-type-qualification";

function rejectDeclarationForms(source: ast.SourceFile): void {
  for (const statement of source.statements) {
    if ((ast.isExportAssignment(statement) && statement.isExportEquals) || ast.isNamespaceExportDeclaration(statement)) {
      nativePackageFailure(`unsupported declaration export form in ${source.fileName}`);
    }
  }
}

async function requireOwnResolution(project: Project, domain: NativePackageDomain, packageRoot: string, node: ast.StringLiteral, path: string): Promise<void> {
  const symbol = await project.checker.getSymbolAtLocation(node);
  const resolved = symbol?.declarations.length === 1 ? await symbol.declarations[0]?.resolve(project) : undefined;
  if (symbol === undefined || await project.checker.isUnknownSymbol(symbol) || resolved === undefined ||
    !ast.isSourceFile(resolved) || !resolved.fileName.startsWith(`${packageRoot}/`) ||
    !domain.files.has(resolved.fileName.slice(packageRoot.length + 1))) {
    nativePackageFailure(`unresolved own import ${node.text} in ${path}`);
  }
}

async function observeOwnFiles(project: Project, domain: NativePackageDomain, packageRoot: string): Promise<number> {
  const program = project.program;
  for (const diagnostics of [await program.getConfigFileParsingDiagnostics(), await program.getProgramDiagnostics(),
    await program.getSyntacticDiagnostics(), await program.getBindDiagnostics()]) {
    if (diagnostics.length > 0) {
      nativePackageFailure(diagnostics.map(diagnostic => `TS${diagnostic.code}: ${diagnostic.text}`).join("; "));
    }
  }
  let ownImports = 0;
  for (const path of domain.codeFiles) {
    const fileName = `${packageRoot}/${path}`;
    const source = await program.getSourceFile(fileName);
    const metadata = await program.getSourceFileMetadata(fileName);
    if (source === undefined || metadata?.impliedNodeFormat !== ModuleKind.ESNext || !source.externalModuleIndicator) {
      nativePackageFailure(`owned file lacks the required ESM format or explicit module syntax: ${path}`);
    }
    rejectDeclarationForms(source);
    for (const node of source.imports) {
      if (!ast.isStringLiteral(node)) { nativePackageFailure(`unsupported module reference in ${path}`); }
      if (!isOwnPackageReference(domain.name, node.text)) { continue; }
      ownImports++;
      await requireOwnResolution(project, domain, packageRoot, node, path);
      if (!source.isDeclarationFile) { ownRuntimeTarget(domain, path, node.text); }
    }
  }
  return ownImports;
}

async function observeMode(domain: NativePackageDomain, mode: "node16-esm" | "bundler"): Promise<number> {
  const packageRoot = `${workspace}/node_modules/${domain.name}`;
  const consumer = `${workspace}/consumer.${mode === "node16-esm" ? "mts" : "ts"}`;
  const config = `${workspace}/tsconfig.json`;
  const files: Record<string, string> = Object.fromEntries([...domain.files].map(([path, text]) => [`${packageRoot}/${path}`, text]));
  files[consumer] = domain.entrypoints.map((entry, index) =>
    `import type * as Entry${index} from ${JSON.stringify(domain.name + entry.subpath.slice(1))};`).join("\n");
  // This is a closed resolution/format observation, as ATTW is. It is not a
  // substitute for the separately required full declaration typecheck gate.
  files[config] = JSON.stringify({ compilerOptions: {
    strict: true, noCheck: false, skipLibCheck: false, skipDefaultLibCheck: false,
    noEmit: true, noLib: true, types: [], allowJs: true, resolveJsonModule: true,
    moduleDetection: "legacy", module: mode === "node16-esm" ? "Node16" : "ESNext",
    moduleResolution: mode === "node16-esm" ? "Node16" : "Bundler",
  }, files: [consumer, ...domain.codeFiles.map(path => `${packageRoot}/${path}`)] });
  const fs = createVirtualFileSystem(files);
  const read = fs.readFile!;
  const entries = fs.getAccessibleEntries!;
  fs.readFile = path => read(path) ?? null;
  fs.getAccessibleEntries = path => entries(path) ?? { files: [], directories: [] };
  const api = new API({ cwd: workspace, fs });
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config);
      if (project === undefined) { nativePackageFailure(`native ${mode} project is unavailable`); }
      const source = await project.program.getSourceFile(consumer);
      if (source === undefined || source.statements.length !== domain.entrypoints.length) {
        nativePackageFailure(`native ${mode} consumer is unavailable`);
      }
      for (const [index, entry] of domain.entrypoints.entries()) {
        const statement = source.statements[index];
        if (statement === undefined || !ast.isImportDeclaration(statement)) { nativePackageFailure(`invalid ${mode} consumer import`); }
        const symbol = await project.checker.getSymbolAtLocation(statement.moduleSpecifier);
        const declarations = symbol?.declarations;
        const resolved = declarations?.length === 1 ? await declarations[0]?.resolve(project) : undefined;
        if (symbol === undefined || await project.checker.isUnknownSymbol(symbol) || resolved === undefined ||
          !ast.isSourceFile(resolved) || !resolved.isDeclarationFile || resolved.fileName !== `${packageRoot}/${entry.types}`) {
          nativePackageFailure(`${mode} export ${entry.subpath} did not resolve to its exact first types target`);
        }
      }
      return await observeOwnFiles(project, domain, packageRoot);
    } finally { await snapshot.dispose(); }
  } finally { await api.close(); }
}

export async function qualifyNativePackageArchive(archiveBytes: Buffer, expectedPackageName: string): Promise<NativePackageTypeQualification> {
  if (typescript.version !== "7.0.2") { nativePackageFailure(`expected exact TypeScript 7.0.2, found ${typescript.version}`); }
  const domain = inspectNativePackageDomain(archiveBytes, expectedPackageName);
  const modes = ["node16-esm", "bundler"] as const;
  const counts: number[] = [];
  for (const mode of modes) { counts.push(await observeMode(domain, mode)); }
  return { packageName: domain.name, packageVersion: domain.version, compilerVersion: "7.0.2", modes,
    typedEntrypoints: domain.entrypoints.length, codeFiles: domain.codeFiles.length, ownImports: counts.reduce((sum, count) => sum + count, 0) };
}
