// Concrete factories selected only by module/feature composition.
export { createSchemaCatalog } from "./adapters/outbound/ajv/schema-catalog.js";
export { createPackagedSchemaReader } from "./adapters/outbound/filesystem/packaged-schema-reader.js";
export { createStrictYamlFileLoader } from "./adapters/inbound/yaml/strict-yaml-file-loader.js";
