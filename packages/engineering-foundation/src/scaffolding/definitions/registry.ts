import { ScaffoldDefinitionRegistry } from "../kernel/definition-registry.js";
import { CONFORMANCE_FIXTURE_DEFINITIONS } from "./conformance-fixture.js";
import { NODE_TYPESCRIPT_LIBRARY_DEFINITIONS } from "./node-typescript-library.js";

export function createAuthorityScaffoldRegistry(): ScaffoldDefinitionRegistry {
  return new ScaffoldDefinitionRegistry([
    ...CONFORMANCE_FIXTURE_DEFINITIONS,
    ...NODE_TYPESCRIPT_LIBRARY_DEFINITIONS
  ]);
}

export function createRenderingRegressionRegistry(): ScaffoldDefinitionRegistry {
  return new ScaffoldDefinitionRegistry(CONFORMANCE_FIXTURE_DEFINITIONS);
}
