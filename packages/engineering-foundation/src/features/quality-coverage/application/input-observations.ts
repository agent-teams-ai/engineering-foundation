import type { ContainedFileObservation } from "../../../source-inventory/api.js";
import type { DependencyDeclaration } from "../../../workspace-inventory/api.js";

export type QualityFileReader = ContainedFileObservation["read"];
export type QualityDependencyDeclaration = DependencyDeclaration;
export { CapabilityInputError, assertNotCancelled } from "../../validation-reporting/api.js";
