import { createFoundationCheck, createFoundationConfigReader } from "../features/foundation-check/module.js";
import { CAPABILITY_REGISTRY } from "./capability-registry.js";

export const loadFoundationConfig = createFoundationConfigReader(new Set(CAPABILITY_REGISTRY.keys()));
export const runFoundationCheck = createFoundationCheck({
  readConfig: loadFoundationConfig,
  capabilities: CAPABILITY_REGISTRY
});
