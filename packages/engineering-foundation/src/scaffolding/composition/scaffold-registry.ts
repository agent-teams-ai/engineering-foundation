import { AjvScaffoldParameterValidation } from "../adapters/outbound/ajv-parameter-validation.js";
import { ScaffoldDefinitionRegistry } from "../kernel/definition-registry.js";
import { CONFORMANCE_FIXTURE_DEFINITIONS } from "../definitions/conformance-fixture.js";
import { NODE_TYPESCRIPT_LIBRARY_DEFINITIONS } from "../definitions/node-typescript-library.js";

export function createAuthorityScaffoldRegistry(): ScaffoldDefinitionRegistry {
  return new ScaffoldDefinitionRegistry([
    ...CONFORMANCE_FIXTURE_DEFINITIONS,
    ...NODE_TYPESCRIPT_LIBRARY_DEFINITIONS
  ], new AjvScaffoldParameterValidation());
}
