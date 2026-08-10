import { assertNotCancelled } from "../../../../strict-yaml.js";
import type { ExecutableSpecificationCatalog } from "../model/executable-specification.js";
import { evaluateExecutableSpecifications } from "../policies/evaluate-executable-specifications.js";
import type { ExecutableSpecificationInspector } from "../ports/executable-specification-inspector.js";

export async function analyzeExecutableSpecifications(
  input: {
    readonly consumerRoot: string;
    readonly catalog: ExecutableSpecificationCatalog;
    readonly signal?: AbortSignal;
  },
  inspector: ExecutableSpecificationInspector
) {
  const observations = [];
  for (const specification of input.catalog.specifications) {
    assertNotCancelled(input.signal);
    observations.push(
      await inspector.inspect({
        consumerRoot: input.consumerRoot,
        specification,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      })
    );
  }
  return evaluateExecutableSpecifications(input.catalog, observations);
}
