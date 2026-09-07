import { createFoundationCheck, createRegisteredFoundationConfigReader } from "../features/foundation-check/module.js";
import { CAPABILITY_REGISTRY } from "./capability-registry.js";
import { assertSchema } from "../schema-catalog.js";
import { loadStrictYamlFile } from "../features/configuration-input/node.js";

export const loadFoundationConfig = createRegisteredFoundationConfigReader(CAPABILITY_REGISTRY, {
  assertSchema,
  loadStrictYamlFile
});
export const runFoundationCheck = createFoundationCheck({
  readConfig: loadFoundationConfig,
  capabilities: CAPABILITY_REGISTRY
});
