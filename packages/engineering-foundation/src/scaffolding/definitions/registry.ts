import { ScaffoldDefinitionRegistry } from "../kernel/definition-registry.js";
import { CONFORMANCE_FIXTURE_DEFINITIONS } from "./conformance-fixture.js";

export function createDefaultScaffoldRegistry(): ScaffoldDefinitionRegistry {
  return new ScaffoldDefinitionRegistry(CONFORMANCE_FIXTURE_DEFINITIONS);
}
