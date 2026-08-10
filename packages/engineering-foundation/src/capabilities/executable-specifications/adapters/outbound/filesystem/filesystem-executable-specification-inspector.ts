import { createHash } from "node:crypto";
import { glob } from "node:fs/promises";
import { resolve } from "node:path";

import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import { CapabilityInputError } from "../../../../../capability-runtime.js";
import {
  ContainedFileReadError,
  readContainedRegularFile
} from "../../../../../filesystem-path-safety.js";
import { assertNotCancelled } from "../../../../../strict-yaml.js";
import { parseStrictJson, StrictJsonError } from "../../../../../strict-json.js";
import { AjvJsonSchemaReleaseInspector } from "../../../../contract-json-schema-releases/adapters/outbound/filesystem/ajv-json-schema-release-inspector.js";
import type { JsonSchemaFixture } from "../../../../contract-json-schema-releases/application/model/json-schema-release.js";
import type {
  ConsumerGateBinding,
  ExecutableSpecification,
  ObservedGateBinding
} from "../../../application/model/executable-specification.js";
import type { ExecutableSpecificationInspector } from "../../../application/ports/executable-specification-inspector.js";

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const IGNORED_GLOBS = ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/coverage/**"];

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

function artifactPaths(specification: ExecutableSpecification): readonly string[] {
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

async function packageCatalog(
  root: string,
  signal?: AbortSignal
): Promise<ReadonlyMap<string, PackageScripts>> {
  const packages = new Map<string, PackageScripts>();
  for await (const candidate of glob("**/package.json", { cwd: root, exclude: IGNORED_GLOBS })) {
    assertNotCancelled(signal);
    const manifestPath = candidate.split("\\").join("/");
    const bytes = await readArtifact(root, manifestPath);
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
            .filter(([, command]) => typeof command === "string" && command.length > 0)
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
    ["typeGeneration", specification.gateBindings.typeGeneration],
    ...(specification.stateModel.kind === "xstate"
      ? ([['spec-model', specification.stateModel.gateBinding]] as const)
      : [])
  ];
}

export class FilesystemExecutableSpecificationInspector
  implements ExecutableSpecificationInspector
{
  readonly #jsonSchemaInspector = new AjvJsonSchemaReleaseInspector();

  async inspect(input: {
    readonly consumerRoot: string;
    readonly specification: ExecutableSpecification;
    readonly signal?: AbortSignal;
  }) {
    assertNotCancelled(input.signal);
    const paths = [...new Set(artifactPaths(input.specification))].toSorted(compareBinaryStrings);
    const content = new Map<string, string>();
    const missingArtifactPaths: string[] = [];
    for (const repositoryPath of paths) {
      assertNotCancelled(input.signal);
      const bytes = await readArtifact(input.consumerRoot, repositoryPath);
      if (bytes === undefined) {
        missingArtifactPaths.push(repositoryPath);
      } else {
        content.set(repositoryPath, createHash("sha256").update(bytes).digest("hex"));
      }
    }
    const fixtures: readonly JsonSchemaFixture[] = input.specification.documents.map(
      (document, index) => ({
        id: `${input.specification.id.slice(0, 90)}.document.${index}`,
        path: document.path,
        schemaId: document.schemaId,
        expectation: "valid"
      })
    );
    const jsonSchemas = await this.#jsonSchemaInspector.inspect({
      consumerRoot: input.consumerRoot,
      schemaPaths: input.specification.schemaPaths,
      fixtures,
      requireMixedExpectations: false,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    const packages = await packageCatalog(input.consumerRoot, input.signal);
    const gates = Object.fromEntries(
      gateEntries(input.specification).map(([role, binding]) => [
        role,
        observeGate(binding, packages)
      ])
    );
    return Object.freeze({
      id: input.specification.id,
      jsonSchemas,
      missingArtifactPaths: Object.freeze(missingArtifactPaths),
      gates: Object.freeze(gates),
      artifactDigest: `sha256:${createHash("sha256")
        .update(canonicalJson(Object.fromEntries(content)), "utf8")
        .digest("hex")}` as const
    });
  }
}
