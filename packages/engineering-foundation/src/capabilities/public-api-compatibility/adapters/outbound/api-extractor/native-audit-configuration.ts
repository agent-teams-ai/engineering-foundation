import { type NativePublicApiContext } from "./native-public-api-engine.js";

import { readFileSync } from "node:fs";

import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parse, type ParseError } from "jsonc-parser";

import type { SourceFile } from "typescript/unstable/ast";

import {
  auditDigest,
  auditRelativePath,
  AUDIT_MAX_BYTES,
  AUDIT_MAX_FILES,
} from "../filesystem/public-api-audit-inputs.js";

import type { ObservationContext } from "./native-audit-context.js";
import { libraryFile, nativeSources, defaultLibrary } from "./native-audit-model.js";

const normalized = (path: string): string => resolve(path).replaceAll("\\", "/");
interface AuditConfiguration {
  readonly options: Readonly<Record<string, unknown>>;
  readonly roots: readonly string[] | undefined;
  readonly include: unknown;
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Unsupported audit compiler configuration object.");
  }
  return value as Record<string, unknown>;
}
function configDependency(
  path: string,
  specifier: string,
  files: ReadonlyMap<string, string>,
): string {
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
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  }
  const selected = candidates.find((candidate) => files.has(normalized(candidate)));
  if (selected === undefined) {
    throw new Error(`Undeclared configuration dependency: ${specifier}.`);
  }
  return normalized(selected);
}
export function prepareNativeFiles(
  context: ObservationContext,
  configFiles: Map<string, string>,
): { readonly configPath: string; readonly files: ReadonlyMap<string, string> } {
  const files = new Map<string, string>();
  for (const [path, digest] of context.allowed) {
    const text = readFileSync(path, "utf8");
    if (auditDigest(text) !== digest) {
      throw new Error("Compiler host input digest mismatch.");
    }
    files.set(normalized(path), text);
  }
  const configPath = normalized(join(context.input.consumerRoot, context.pkg.tsconfigPath));
  const configurations = new Map<string, Record<string, unknown>>();
  const visiting = new Set<string>();
  function readConfiguration(path: string): AuditConfiguration {
    if (visiting.has(path)) {
      throw new Error("Circular audit compiler configuration.");
    }
    visiting.add(path);
    const text = files.get(path);
    if (text === undefined) {
      throw new Error(`Undeclared configuration dependency: ${path}.`);
    }
    const errors: ParseError[] = [];
    const configuration = object(
      parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown,
    );
    if (errors.length > 0) {
      throw new Error("Invalid audit compiler JSONC configuration.");
    }
    configurations.set(path, configuration);
    configFiles.set(resolve(path), auditDigest(text));
    const optionLayers: Readonly<Record<string, unknown>>[] = [];
    let roots: readonly string[] | undefined;
    let include: unknown;
    const extended = configuration["extends"];
    if (extended !== undefined) {
      const bases = typeof extended === "string" ? [extended] : extended;
      if (
        !Array.isArray(bases) ||
        !bases.every((base): base is string => typeof base === "string")
      ) {
        throw new Error("Unsupported audit compiler inheritance.");
      }
      for (const base of bases) {
        const inherited = readConfiguration(configDependency(path, base, files));
        optionLayers.push(inherited.options);
        roots = inherited.roots ?? roots;
        include = inherited.include ?? include;
      }
    }
    if (configuration["references"] !== undefined) {
      throw new Error("Compiler plugins and project references are outside the audit boundary.");
    }
    if (configuration["compilerOptions"] !== undefined) {
      optionLayers.push(object(configuration["compilerOptions"]));
    }
    if (configuration["files"] !== undefined) {
      const specified: unknown = configuration["files"];
      if (
        !Array.isArray(specified) ||
        !specified.every((file): file is string => typeof file === "string")
      ) {
        throw new Error("Unsupported audit compiler root files.");
      }
      roots = specified.map((file) => normalized(resolve(dirname(path), file)));
    }
    include = configuration["include"] ?? include;
    visiting.delete(path);
    return {
      options: Object.fromEntries(optionLayers.flatMap((layer) => Object.entries(layer))),
      roots,
      include,
    };
  }
  const configuration = readConfiguration(configPath);
  if (configuration.options["plugins"] !== undefined) {
    throw new Error("Compiler plugins and project references are outside the audit boundary.");
  }
  if (
    configuration.options["skipLibCheck"] === true ||
    configuration.options["skipDefaultLibCheck"] === true ||
    configuration.options["noCheck"] === true
  ) {
    throw new Error("Compiler diagnostic suppression is unsupported for audit admission.");
  }
  if (
    configuration.roots === undefined ||
    (configuration.include !== undefined &&
      (!Array.isArray(configuration.include) || configuration.include.length > 0))
  ) {
    throw new Error("Audit requires explicit tsconfig files; glob discovery unsupported.");
  }
  for (const path of configuration.roots) {
    if (!context.allowed.has(resolve(path))) {
      throw new Error("Undeclared compiler root.");
    }
  }
  const raw = configurations.get(configPath)!;
  const rawOptions = raw["compilerOptions"] === undefined ? {} : object(raw["compilerOptions"]);
  const configuredLibraries = configuration.options["lib"];
  if (
    configuredLibraries !== undefined &&
    (!Array.isArray(configuredLibraries) ||
      !configuredLibraries.every((library): library is string => typeof library === "string"))
  ) {
    throw new Error("Unsupported audit compiler libraries.");
  }
  const entryPoint =
    context.entry === undefined
      ? []
      : [normalized(join(context.input.consumerRoot, context.entry.declarationEntryPoint))];
  files.set(
    configPath,
    JSON.stringify({
      ...raw,
      files: [...new Set([...configuration.roots, ...entryPoint])],
      compilerOptions: {
        ...rawOptions,
        outDir: null,
        declarationDir: null,
        ...(configuredLibraries === undefined
          ? {}
          : {
              lib: [
                ...configuredLibraries,
                ...(configuredLibraries.some((library) =>
                  /^(?:lib\.)?dom(?:\.d\.ts)?$/iu.test(library),
                )
                  ? []
                  : ["DOM"]),
              ],
            }),
      },
    }),
  );
  return { configPath, files };
}
export async function validateCompilerSources(
  native: NativePublicApiContext,
  context: ObservationContext,
): Promise<readonly SourceFile[]> {
  const sources = await nativeSources(native);
  let bytes = 0;
  for (const source of sources) {
    bytes += Buffer.byteLength(source.text);
    if (sources.length > AUDIT_MAX_FILES || bytes > AUDIT_MAX_BYTES) {
      throw new Error("Compiler input budget exhausted.");
    }
    if (!source.isDeclarationFile) {
      throw new Error("Only prepared declarations are supported.");
    }
    if (await defaultLibrary(native, source)) {
      if (!libraryFile(source.fileName)) {
        throw new Error("Compiler library outside pinned native toolchain.");
      }
    } else if (context.allowed.get(resolve(source.fileName)) !== auditDigest(source.text)) {
      throw new Error(`Compiler input outside verified subject: ${source.fileName}.`);
    }
  }
  return sources;
}

export function compilerEnvironment(
  options: Readonly<Record<string, unknown>>,
  context: ObservationContext,
): string {
  const { input, subjectRoot } = context;
  return JSON.stringify(options, (key, value: unknown) => {
    if (key === "configFile") {
      return;
    }
    if (typeof value === "string") {
      for (const candidate of input.declarations.packages) {
        const packageRoot = resolve(input.consumerRoot, dirname(candidate.manifestPath));
        const local = auditRelativePath(packageRoot, value);
        if (local !== undefined) {
          return `package:${candidate.packageName}/${local.split(sep).join("/")}`;
        }
      }
      const local = auditRelativePath(subjectRoot, value);
      if (local !== undefined) {
        return `<subject-root>/${local.split(sep).join("/")}`;
      }
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return value;
  });
}
