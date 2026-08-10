import type { JsonSchemaInspection } from "../../../contract-json-schema-releases/application/model/json-schema-release.js";

export interface ExecutableSpecificationDocument {
  readonly path: string;
  readonly schemaId: string;
}

export interface GeneratedTypeBinding {
  readonly schemaId: string;
  readonly outputPath: string;
}

export interface ConsumerGateBinding {
  readonly packageName: string;
  readonly script: string;
}

export interface NoStateModel {
  readonly kind: "none";
}

export interface XstateStateModel {
  readonly kind: "xstate";
  readonly axes: readonly string[];
  readonly modelPath: string;
  readonly adapterPath: string;
  readonly tracesPath: string;
  readonly diagramPath: string;
  readonly gateBinding: ConsumerGateBinding;
}

export interface ExecutableSpecification {
  readonly id: string;
  readonly ownerDocs: readonly string[];
  readonly adrRefs: readonly string[];
  readonly schemaPaths: readonly string[];
  readonly documents: readonly ExecutableSpecificationDocument[];
  readonly generatedTypes: readonly GeneratedTypeBinding[];
  readonly gateBindings: {
    readonly typeGeneration: ConsumerGateBinding;
    readonly property: ConsumerGateBinding;
    readonly mutation: ConsumerGateBinding;
  };
  readonly stateModel: NoStateModel | XstateStateModel;
}

export interface ExecutableSpecificationCatalog {
  readonly schemaVersion: 1;
  readonly configPath: string;
  readonly catalogPath: string;
  readonly specifications: readonly ExecutableSpecification[];
}

export interface ObservedGateBinding extends ConsumerGateBinding {
  readonly manifestPath?: string;
  readonly packageExists: boolean;
  readonly scriptExists: boolean;
}

export interface ExecutableSpecificationObservation {
  readonly id: string;
  readonly jsonSchemas: JsonSchemaInspection;
  readonly missingArtifactPaths: readonly string[];
  readonly gates: Readonly<Record<string, ObservedGateBinding>>;
  readonly artifactDigest: `sha256:${string}`;
}
