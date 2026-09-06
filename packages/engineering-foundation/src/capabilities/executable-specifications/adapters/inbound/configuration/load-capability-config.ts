import type { ExecutableSpecificationCatalog } from "../../../application/model/executable-specification.js";
import { assertConfigurationNotCancelled } from "../../../application/configuration-input.js";
import { readCatalog, type CatalogReaderDependencies } from "./read-catalog.js";
import { parseConfigurationPath, parseCatalogPath, parseCatalogInput } from "./parse-capability-config.js";

export interface ExecutableConfigurationDependencies extends CatalogReaderDependencies {
  readonly readYaml: (consumerRoot: string, configPath: string, phase: string, signal?: AbortSignal) => Promise<unknown>;
  readonly assertSchema: (schemaId: "quality-executable-specifications/v1" | "quality-executable-specification-catalog/v1", input: unknown, phase: string) => Promise<void>;
}

export async function loadCapabilityConfig(
  dependencies: ExecutableConfigurationDependencies,
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<ExecutableSpecificationCatalog> {
  parseConfigurationPath(configPath);
  const input = await dependencies.readYaml(consumerRoot, configPath, "executable-specification-config", signal);
  assertConfigurationNotCancelled(signal);
  await dependencies.assertSchema("quality-executable-specifications/v1", input, "executable-specification-config");
  const catalogPath = parseCatalogPath(input);
  const catalogInput = await readCatalog(dependencies, consumerRoot, catalogPath);
  assertConfigurationNotCancelled(signal);
  await dependencies.assertSchema("quality-executable-specification-catalog/v1", catalogInput, "executable-specification-catalog");
  return parseCatalogInput(catalogInput, configPath, catalogPath);
}
