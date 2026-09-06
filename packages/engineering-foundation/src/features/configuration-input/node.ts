// Static feature composition selects the shared source observation implementation.
import { containedFileObservation } from "../../source-inventory/node.js";
import { createStrictYamlFileLoader } from "./adapters/inbound/yaml/strict-yaml-file-loader.js";

export const loadStrictYamlFile = createStrictYamlFileLoader(containedFileObservation);
