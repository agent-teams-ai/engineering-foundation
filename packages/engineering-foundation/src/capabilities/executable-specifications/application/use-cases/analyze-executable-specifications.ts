import { CapabilityInputError,assertNotCancelled } from "../../../../features/validation-reporting/api.js";
import type { ExecutableSpecificationCatalog } from "../model/executable-specification.js";
import {
  evaluateExecutableSpecificationTopology,
  evaluateExecutableSpecifications
} from "../policies/evaluate-executable-specifications.js";
import type { ExecutableSpecificationInspector } from "../ports/executable-specification-inspector.js";
import { executableSpecificationArtifactPaths } from "../policies/portable-executable-specification-path.js";

export async function analyzeExecutableSpecifications(
  input: {
    readonly consumerRoot: string;
    readonly catalog: ExecutableSpecificationCatalog;
    readonly signal?: AbortSignal;
  },
  inspector: ExecutableSpecificationInspector
) {
  assertNotCancelled(input.signal);
  const topologyDiagnostics = evaluateExecutableSpecificationTopology(input.catalog);
  if (topologyDiagnostics.length > 0) {
    return topologyDiagnostics;
  }
  const artifactCount = new Set(
    input.catalog.specifications.flatMap(executableSpecificationArtifactPaths)
  ).size;
  if (artifactCount > 1_024) {
    throw new CapabilityInputError({
      code: "EXECUTABLE_SPECIFICATION_ARTIFACT_COUNT_EXCEEDED",
      message: "Executable specification catalogs may reference at most 1024 unique artifacts.",
      phase: "executable-specification-preflight",
      retryable: false
    });
  }
  const observations = await inspector.inspectCatalog({
    consumerRoot: input.consumerRoot,
    catalog: input.catalog,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  if (
    observations.length !== input.catalog.specifications.length ||
    observations.some(
      (observation, index) => observation.id !== input.catalog.specifications[index]?.id
    )
  ) {
    throw new CapabilityInputError({
      code: "EXECUTABLE_SPECIFICATION_OBSERVATION_INVALID",
      message: "Executable specification inspection must return one ordered observation for every catalog entry.",
      phase: "executable-specification-inspection",
      retryable: false
    });
  }
  return evaluateExecutableSpecifications(input.catalog, observations);
}
