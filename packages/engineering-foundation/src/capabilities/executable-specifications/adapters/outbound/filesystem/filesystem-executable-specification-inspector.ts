import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import { CapabilityInputError,assertNotCancelled } from "../../../../../features/validation-reporting/api.js";
import { ContainedFileReadError } from "../../../../../source-inventory/api.js";
import { readContainedRegularFile } from "../../../../../source-inventory/node.js";
import { parseStrictJson, StrictJsonError } from "@agent-teams/repository-mutation/serialization";
import type { JsonSchemaInspectorFactory } from "../../../application/ports/json-schema-inspector-factory.js";
import type { WorkspaceManifestPathReader } from "../../../application/ports/workspace-manifest-path-reader.js";
import type {
  JsonSchemaFixture,
  ConsumerGateBinding,
  ExecutableSpecification,
  ObservedGateBinding
} from "../../../application/model/executable-specification.js";

import type { ExecutableSpecificationInspector } from "../../../application/ports/executable-specification-inspector.js";
import {
  executableSpecificationArtifactPaths,
  executableSpecificationPathDeclarations,
  portableExecutableSpecificationPathIdentity,
  portableExecutableSpecificationPathProblem
} from "../../../application/policies/portable-executable-specification-path.js";

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_AGGREGATE_ARTIFACT_BYTES = 32 * 1024 * 1024;

interface PackageScripts {
  readonly manifestPath: string;
  readonly scripts: ReadonlySet<string>;
}


function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "executable-specification-inspection",
    retryable: false
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => compareBinaryStrings(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  inputError("EXECUTABLE_SPECIFICATION_DIGEST_INVALID", "Artifact digest input is invalid.");
}

async function readArtifact(
  root: string,
  repositoryPath: string
): Promise<Buffer | undefined> {
  try {
    return await readContainedRegularFile({
      candidate: resolve(root, repositoryPath),
      maxBytes: MAX_ARTIFACT_BYTES,
      root
    });
  } catch (error) {
    if (error instanceof ContainedFileReadError) {
      if (error.failure === "missing") {
        return undefined;
      }
      inputError(
        `EXECUTABLE_SPECIFICATION_ARTIFACT_${error.failure.toUpperCase()}`,
        `Specification artifact is not a safe contained regular file: ${repositoryPath}.`
      );
    }
    throw error;
  }
}

class ArtifactReadSession {
  readonly #cache = new Map<
    string,
    { readonly firstPath: string; readonly result: Promise<Buffer | undefined> }
  >();
  #aggregateBytes = 0;

  constructor(
    private readonly root: string,
    private readonly maxAggregateBytes: number
  ) {}

  async read(repositoryPath: string): Promise<Buffer | undefined> {
    const identity = portableExecutableSpecificationPathIdentity(repositoryPath);
    const cached = this.#cache.get(identity);
    if (cached !== undefined) {
      if (cached.firstPath !== repositoryPath) {
        inputError(
          "EXECUTABLE_SPECIFICATION_ARTIFACT_PATH_COLLISION",
          `Artifact paths have the same portable identity: ${cached.firstPath} and ${repositoryPath}.`
        );
      }
      return cached.result;
    }
    const result = readArtifact(this.root, repositoryPath).then((bytes) => {
      if (bytes !== undefined) {
        if (bytes.byteLength > this.maxAggregateBytes - this.#aggregateBytes) {
          inputError(
            "EXECUTABLE_SPECIFICATION_AGGREGATE_BYTES_EXCEEDED",
            "Executable specification artifacts and workspace manifests exceed the 32 MiB aggregate inspection budget."
          );
        }
        this.#aggregateBytes += bytes.byteLength;
      }
      return bytes;
    });
    this.#cache.set(identity, { firstPath: repositoryPath, result });
    return result;
  }
}

async function packageCatalog(
  manifestPaths: readonly string[],
  artifacts: ArtifactReadSession,
  signal?: AbortSignal
): Promise<ReadonlyMap<string, PackageScripts>> {
  const packages = new Map<string, PackageScripts>();
  for (const manifestPath of manifestPaths) {
    assertNotCancelled(signal);
    const bytes = await artifacts.read(manifestPath);
    if (bytes === undefined) {
      continue;
    }
    let value: unknown;
    try {
      value = parseStrictJson(bytes.toString("utf8"));
    } catch (error) {
      if (error instanceof StrictJsonError && error.failure === "duplicate-key") {
        inputError(
          "EXECUTABLE_SPECIFICATION_PACKAGE_MANIFEST_DUPLICATE_KEY",
          `Package manifest contains duplicate object keys: ${manifestPath}.`
        );
      }
      inputError(
        "EXECUTABLE_SPECIFICATION_PACKAGE_MANIFEST_INVALID",
        `Package manifest is invalid JSON: ${manifestPath}.`
      );
    }
    if (!isRecord(value) || typeof value["name"] !== "string") {
      continue;
    }
    const name = value["name"];
    if (packages.has(name)) {
      inputError(
        "EXECUTABLE_SPECIFICATION_PACKAGE_DUPLICATE",
        `Gate package name is not unique in the workspace: ${name}.`
      );
    }
    const scripts = isRecord(value["scripts"])
      ? new Set(
          Object.entries(value["scripts"])
            .filter(([, command]) => typeof command === "string" && command.trim().length > 0)
            .map(([script]) => script)
        )
      : new Set<string>();
    packages.set(name, { manifestPath, scripts });
  }
  return packages;
}

function observeGate(
  binding: ConsumerGateBinding,
  packages: ReadonlyMap<string, PackageScripts>
): ObservedGateBinding {
  const target = packages.get(binding.packageName);
  return Object.freeze({
    ...binding,
    ...(target === undefined ? {} : { manifestPath: target.manifestPath }),
    packageExists: target !== undefined,
    scriptExists: target?.scripts.has(binding.script) ?? false
  });
}

function gateEntries(
  specification: ExecutableSpecification
): readonly (readonly [string, ConsumerGateBinding])[] {
  return [
    ["mutation", specification.gateBindings.mutation],
    ["property", specification.gateBindings.property],
    ...(specification.gateBindings.typeGeneration === undefined
      ? []
      : ([['typeGeneration', specification.gateBindings.typeGeneration]] as const)),
    ...(specification.stateModel.kind === "xstate"
      ? ([['spec-model', specification.stateModel.gateBinding]] as const)
      : [])
  ];
}

export class FilesystemExecutableSpecificationInspector
  implements ExecutableSpecificationInspector
{
  readonly #workspaceManifestPathReader: WorkspaceManifestPathReader;
  readonly #maxAggregateArtifactBytes: number;

  constructor(
    workspaceManifestPathReader: WorkspaceManifestPathReader,
    private readonly createJsonSchemaInspector: JsonSchemaInspectorFactory,
    maxAggregateArtifactBytes = MAX_AGGREGATE_ARTIFACT_BYTES
  ) {
    if (
      !Number.isSafeInteger(maxAggregateArtifactBytes) ||
      maxAggregateArtifactBytes < 1 ||
      maxAggregateArtifactBytes > MAX_AGGREGATE_ARTIFACT_BYTES
    ) {
      throw new TypeError("Aggregate artifact budget must be a positive safe integer up to 32 MiB.");
    }
    this.#workspaceManifestPathReader = workspaceManifestPathReader;
    this.#maxAggregateArtifactBytes = maxAggregateArtifactBytes;
  }

  async inspectCatalog(input: {
    readonly consumerRoot: string;
    readonly catalog: import("../../../application/model/executable-specification.js").ExecutableSpecificationCatalog;
    readonly signal?: AbortSignal;
  }) {
    assertNotCancelled(input.signal);
    const artifacts = new ArtifactReadSession(
      input.consumerRoot,
      this.#maxAggregateArtifactBytes
    );
    const jsonSchemaInspector = this.createJsonSchemaInspector((repositoryPath) =>
      artifacts.read(repositoryPath)
    );
    const manifestPaths = await this.#workspaceManifestPathReader.discoverManifestPaths(
      input.consumerRoot,
      "pnpm-workspace.yaml",
      input.signal
    );
    const occupiedPaths = new Map<
      string,
      { path: string; role: ReturnType<typeof executableSpecificationPathDeclarations>[number]["role"] }
    >();
    for (const declaration of executableSpecificationPathDeclarations(input.catalog)) {
      const identity = portableExecutableSpecificationPathIdentity(declaration.path);
      occupiedPaths.set(identity, declaration);
    }
    const selectedManifestIdentities = new Map<string, string>();
    for (const manifestPath of manifestPaths) {
      const portabilityProblem = portableExecutableSpecificationPathProblem(manifestPath);
      if (portabilityProblem !== undefined) {
        inputError(
          "EXECUTABLE_SPECIFICATION_MANIFEST_PATH_NOT_PORTABLE",
          `Selected workspace manifest path is not portable: ${manifestPath} (${portabilityProblem}).`
        );
      }
      const identity = portableExecutableSpecificationPathIdentity(manifestPath);
      const previousManifest = selectedManifestIdentities.get(identity);
      if (previousManifest !== undefined && previousManifest !== manifestPath) {
        inputError(
          "EXECUTABLE_SPECIFICATION_MANIFEST_PATH_COLLISION",
          `Selected workspace manifests have the same portable path identity: ${previousManifest} and ${manifestPath}.`
        );
      }
      const occupiedPath = occupiedPaths.get(identity);
      if (
        occupiedPath !== undefined &&
        !(
          occupiedPath.role === "reserved-root-package" &&
          occupiedPath.path === "package.json" &&
          manifestPath === "package.json"
        )
      ) {
        inputError(
          "EXECUTABLE_SPECIFICATION_MANIFEST_PATH_COLLISION",
          `Selected workspace manifest collides with a declared or reserved executable specification path: ${manifestPath}.`
        );
      }
      selectedManifestIdentities.set(identity, manifestPath);
    }
    const uniqueManifestPaths = [...selectedManifestIdentities.values()];
    const paths = [
      ...new Set(input.catalog.specifications.flatMap(executableSpecificationArtifactPaths))
    ].toSorted(compareBinaryStrings);
    if (
      new Set(
        [...uniqueManifestPaths, ...paths].map(portableExecutableSpecificationPathIdentity)
      ).size > 1_024
    ) {
      inputError(
        "EXECUTABLE_SPECIFICATION_ARTIFACT_COUNT_EXCEEDED",
        "Executable specification catalogs and selected workspace packages may reference at most 1024 unique artifacts."
      );
    }
    const packages = await packageCatalog(uniqueManifestPaths, artifacts, input.signal);
    for (const repositoryPath of paths) {
      assertNotCancelled(input.signal);
      await artifacts.read(repositoryPath);
    }
    const observations = [];
    for (const specification of input.catalog.specifications) {
      assertNotCancelled(input.signal);
      const content = new Map<string, string>();
      const missingArtifactPaths: string[] = [];
      for (const repositoryPath of [...new Set(executableSpecificationArtifactPaths(specification))].toSorted(
        compareBinaryStrings
      )) {
        const bytes = await artifacts.read(repositoryPath);
        if (bytes === undefined) {
          missingArtifactPaths.push(repositoryPath);
        } else {
          content.set(repositoryPath, createHash("sha256").update(bytes).digest("hex"));
        }
      }
      const fixtures: readonly JsonSchemaFixture[] = specification.documents.map(
        (document, index) => ({
          id: `${specification.id.slice(0, 90)}.document.${index}`,
          path: document.path,
          schemaId: document.schemaId,
          expectation: "valid"
        })
      );
      const jsonSchemas = await jsonSchemaInspector.inspect({
        consumerRoot: input.consumerRoot,
        schemaPaths: specification.schemaPaths,
        fixtures,
        requireMixedExpectations: false,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
      const gates = Object.fromEntries(
        gateEntries(specification).map(([role, binding]) => [
          role,
          observeGate(binding, packages)
        ])
      );
      observations.push(
        Object.freeze({
          id: specification.id,
          jsonSchemas,
          missingArtifactPaths: Object.freeze(missingArtifactPaths),
          gates: Object.freeze(gates),
          artifactDigest: `sha256:${createHash("sha256")
            .update(canonicalJson(Object.fromEntries(content)), "utf8")
            .digest("hex")}` as const
        })
      );
    }
    return Object.freeze(observations);
  }
}
