import type { ScaffoldAuthorityObservation, ScaffoldInstalledVersion } from "../../application/ports/authority-observation.js";
import type { ScaffoldDefinitionRegistry } from "../../kernel/definition-registry.js";

export interface ScaffoldAuthorityDependencies {
  readonly observation: ScaffoldAuthorityObservation;
  readonly installedVersion: ScaffoldInstalledVersion;
  readonly createRegistry: () => ScaffoldDefinitionRegistry;
}
