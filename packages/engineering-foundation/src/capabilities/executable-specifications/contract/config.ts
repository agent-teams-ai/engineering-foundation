import { resolve } from "node:path";

import { CapabilityInputError,assertNotCancelled } from "../../../features/validation-reporting/api.js";
import { ContainedFileReadError, assertRepositoryRelativePath } from "../../../source-inventory/api.js";
import { readContainedRegularFile } from "../../../source-inventory/node.js";
import { assertSchema } from "../../../schema-catalog.js";

import { loadStrictYamlFile } from "../../../features/configuration-input/node.js";
import { parseStrictJson, StrictJsonError } from "../../../strict-json.js";
import type {
  ConsumerGateBinding,
  ExecutableSpecification,
  ExecutableSpecificationCatalog,
  ExecutableSpecificationDocument,
  GeneratedTypeBinding,
  NoStateModel,
  XstateStateModel
} from "../application/model/executable-specification.js";
import { portableExecutableSpecificationPathProblem } from "../application/policies/portable-executable-specification-path.js";

export const CAPABILITY_ID = "quality.executable-specifications" as const;
export const CAPABILITY_CONFIG_SCHEMA_VERSION = 1 as const;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "executable-specification-config",
    retryable: false
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputError("EXECUTABLE_SPECIFICATION_CONFIG_INVALID", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") {
    inputError("EXECUTABLE_SPECIFICATION_CONFIG_INVALID", `${field} must be a string.`);
  }
  return value;
}

function list(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    inputError("EXECUTABLE_SPECIFICATION_CONFIG_INVALID", `${field} must be an array.`);
  }
  return value;
}

function path(value: unknown, field: string): string {
  const repositoryPath = string(value, field);
  assertRepositoryRelativePath(repositoryPath, "executable-specification-config");
  const portabilityProblem = portableExecutableSpecificationPathProblem(repositoryPath);
  if (portabilityProblem !== undefined) {
    inputError(
      "EXECUTABLE_SPECIFICATION_PATH_NOT_PORTABLE",
      `${field} is not a portable executable specification path: ${portabilityProblem}.`
    );
  }
  return repositoryPath;
}

function gate(value: unknown, field: string): ConsumerGateBinding {
  const source = record(value, field);
  return Object.freeze({
    packageName: string(source["packageName"], `${field}.packageName`),
    script: string(source["script"], `${field}.script`)
  });
}

function document(value: unknown, field: string): ExecutableSpecificationDocument {
  const source = record(value, field);
  return Object.freeze({
    path: path(source["path"], `${field}.path`),
    schemaId: string(source["schemaId"], `${field}.schemaId`)
  });
}

function generatedType(value: unknown, field: string): GeneratedTypeBinding {
  const source = record(value, field);
  return Object.freeze({
    schemaId: string(source["schemaId"], `${field}.schemaId`),
    outputPath: path(source["outputPath"], `${field}.outputPath`)
  });
}

function stateModel(value: unknown, field: string): NoStateModel | XstateStateModel {
  const source = record(value, field);
  if (source["kind"] === "none") {
    return Object.freeze({ kind: "none" });
  }
  if (source["kind"] !== "xstate") {
    inputError("EXECUTABLE_SPECIFICATION_CONFIG_INVALID", `${field}.kind is invalid.`);
  }
  return Object.freeze({
    kind: "xstate",
    axes: Object.freeze(
      list(source["axes"], `${field}.axes`).map((entry, index) =>
        string(entry, `${field}.axes[${index}]`)
      )
    ),
    modelPath: path(source["modelPath"], `${field}.modelPath`),
    adapterPath: path(source["adapterPath"], `${field}.adapterPath`),
    tracesPath: path(source["tracesPath"], `${field}.tracesPath`),
    diagramPath: path(source["diagramPath"], `${field}.diagramPath`),
    gateBinding: gate(source["gateBinding"], `${field}.gateBinding`)
  });
}

function specification(value: unknown, index: number): ExecutableSpecification {
  const field = `specifications[${index}]`;
  const source = record(value, field);
  const gates = record(source["gateBindings"], `${field}.gateBindings`);
  const generatedTypes = Object.freeze(
    list(source["generatedTypes"], `${field}.generatedTypes`).map((entry, typeIndex) =>
      generatedType(entry, `${field}.generatedTypes[${typeIndex}]`)
    )
  );
  return Object.freeze({
    id: string(source["id"], `${field}.id`),
    ownerDocs: Object.freeze(
      list(source["ownerDocs"], `${field}.ownerDocs`).map((entry, pathIndex) =>
        path(entry, `${field}.ownerDocs[${pathIndex}]`)
      )
    ),
    adrRefs: Object.freeze(
      list(source["adrRefs"], `${field}.adrRefs`).map((entry, pathIndex) =>
        path(entry, `${field}.adrRefs[${pathIndex}]`)
      )
    ),
    schemaPaths: Object.freeze(
      list(source["schemaPaths"], `${field}.schemaPaths`).map((entry, pathIndex) =>
        path(entry, `${field}.schemaPaths[${pathIndex}]`)
      )
    ),
    documents: Object.freeze(
      list(source["documents"], `${field}.documents`).map((entry, documentIndex) =>
        document(entry, `${field}.documents[${documentIndex}]`)
      )
    ),
    generatedTypes,
    gateBindings: Object.freeze({
      ...(generatedTypes.length === 0
        ? {}
        : {
            typeGeneration: gate(
              gates["typeGeneration"],
              `${field}.gateBindings.typeGeneration`
            )
          }),
      property: gate(gates["property"], `${field}.gateBindings.property`),
      mutation: gate(gates["mutation"], `${field}.gateBindings.mutation`)
    }),
    stateModel: stateModel(source["stateModel"], `${field}.stateModel`)
  });
}

async function readCatalog(consumerRoot: string, catalogPath: string): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await readContainedRegularFile({
      candidate: resolve(consumerRoot, catalogPath),
      maxBytes: MAX_CATALOG_BYTES,
      root: consumerRoot
    });
  } catch (error) {
    if (error instanceof ContainedFileReadError) {
      inputError(
        `EXECUTABLE_SPECIFICATION_CATALOG_${error.failure.toUpperCase()}`,
        `Executable specification catalog is not a contained regular file: ${catalogPath}.`
      );
    }
    throw error;
  }
  try {
    return parseStrictJson(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof StrictJsonError && error.failure === "duplicate-key") {
      inputError(
        "EXECUTABLE_SPECIFICATION_CATALOG_DUPLICATE_KEY",
        `Executable specification catalog contains duplicate object keys: ${catalogPath}.`
      );
    }
    inputError(
      "EXECUTABLE_SPECIFICATION_CATALOG_INVALID",
      `Executable specification catalog is not valid JSON: ${catalogPath}.`
    );
  }
}

export async function loadCapabilityConfig(
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<ExecutableSpecificationCatalog> {
  path(configPath, "configPath");
  const input = await loadStrictYamlFile(
    consumerRoot,
    configPath,
    "executable-specification-config",
    signal
  );
  assertNotCancelled(signal);
  await assertSchema("quality-executable-specifications/v1", input, "executable-specification-config");
  const config = record(input, "executable specification config");
  const catalogPath = path(config["catalogPath"], "catalogPath");
  if (!catalogPath.endsWith(".json")) {
    inputError("EXECUTABLE_SPECIFICATION_CATALOG_PATH_INVALID", "catalogPath must name a JSON file.");
  }
  const catalogInput = await readCatalog(consumerRoot, catalogPath);
  assertNotCancelled(signal);
  await assertSchema(
    "quality-executable-specification-catalog/v1",
    catalogInput,
    "executable-specification-catalog"
  );
  const catalog = record(catalogInput, "executable specification catalog");
  return Object.freeze({
    schemaVersion: 1,
    configPath,
    catalogPath,
    specifications: Object.freeze(
      list(catalog["specifications"], "specifications").map(specification)
    )
  });
}
