import type {
  ExecutableSpecification,
  ExecutableSpecificationCatalog
} from "../model/executable-specification.js";

const PORTABLE_SEGMENT = /^[A-Za-z0-9._@+-]+$/u;
const WINDOWS_DEVICE_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export function portableExecutableSpecificationPathProblem(
  repositoryPath: string
): string | undefined {
  for (const segment of repositoryPath.split("/")) {
    if (segment.length > 255) {
      return "segments must not exceed 255 ASCII characters";
    }
    if (segment === "." || segment === "..") {
      return "dot segments are not allowed";
    }
    if (!PORTABLE_SEGMENT.test(segment)) {
      return "segments may contain only ASCII letters, digits, dot, underscore, at sign, plus, and hyphen";
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      return "segments must not end with a dot or space";
    }
    if (WINDOWS_DEVICE_BASENAME.test(segment)) {
      return "segments must not use a reserved Windows device basename";
    }
  }
  return undefined;
}

export function portableExecutableSpecificationPathIdentity(repositoryPath: string): string {
  return repositoryPath.toLowerCase();
}

export function executableSpecificationArtifactPaths(
  specification: ExecutableSpecification
): readonly string[] {
  const statePaths =
    specification.stateModel.kind === "xstate"
      ? [
          specification.stateModel.adapterPath,
          specification.stateModel.diagramPath,
          specification.stateModel.modelPath,
          specification.stateModel.tracesPath
        ]
      : [];
  return [
    ...specification.ownerDocs,
    ...specification.adrRefs,
    ...specification.schemaPaths,
    ...specification.documents.map((document) => document.path),
    ...specification.generatedTypes.map((binding) => binding.outputPath),
    ...statePaths
  ];
}

function executableSpecificationReservedPaths(
  catalog: ExecutableSpecificationCatalog
): readonly ExecutableSpecificationPathDeclaration[] {
  return [
    { path: "foundation.config.yaml", role: "reserved-foundation-config" },
    { path: catalog.configPath, role: "reserved-capability-config" },
    { path: catalog.catalogPath, role: "reserved-catalog" },
    { path: "package.json", role: "reserved-root-package" },
    { path: "pnpm-workspace.yaml", role: "reserved-workspace" }
  ];
}

export interface ExecutableSpecificationPathDeclaration {
  readonly path: string;
  readonly role:
    | "owner"
    | "adr"
    | "schema"
    | "document"
    | "generated-model"
    | "reserved-foundation-config"
    | "reserved-capability-config"
    | "reserved-catalog"
    | "reserved-root-package"
    | "reserved-workspace";
}

export function executableSpecificationPathDeclarations(
  catalog: ExecutableSpecificationCatalog
): readonly ExecutableSpecificationPathDeclaration[] {
  return [
    ...executableSpecificationReservedPaths(catalog),
    ...catalog.specifications.flatMap((specification) => [
      ...specification.ownerDocs.map((path) => ({ path, role: "owner" as const })),
      ...specification.adrRefs.map((path) => ({ path, role: "adr" as const })),
      ...specification.schemaPaths.map((path) => ({ path, role: "schema" as const })),
      ...specification.documents.map(({ path }) => ({ path, role: "document" as const })),
      ...specification.generatedTypes.map(({ outputPath: path }) => ({
        path,
        role: "generated-model" as const
      })),
      ...(specification.stateModel.kind === "xstate"
        ? [
            specification.stateModel.modelPath,
            specification.stateModel.adapterPath,
            specification.stateModel.tracesPath,
            specification.stateModel.diagramPath
          ].map((path) => ({ path, role: "generated-model" as const }))
        : [])
    ])
  ];
}
