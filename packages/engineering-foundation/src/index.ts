export {
  FOUNDATION_CAPABILITIES,
  FOUNDATION_CONFIG_SCHEMA_VERSION,
  FOUNDATION_PROJECT_KINDS,
  defineFoundationConfig,
  parseFoundationConfig
} from "./config.js";
export type {
  FoundationCapabilityConfig,
  FoundationCapabilityName,
  FoundationConfig,
  FoundationProjectKind
} from "./config.js";
export {
  FOUNDATION_METADATA_SCHEMA_VERSION,
  inspectFoundationPackage,
  parseFoundationPackageSelfCheck
} from "./package-self-check.js";
export type { FoundationPackageSelfCheck } from "./package-self-check.js";
export { FoundationError } from "./errors.js";
export type { FoundationErrorCode } from "./errors.js";
