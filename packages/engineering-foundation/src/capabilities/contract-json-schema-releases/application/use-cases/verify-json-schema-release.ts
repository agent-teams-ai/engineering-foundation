import type {
  JsonSchemaInspection,
  JsonSchemaReleasePolicy
} from "../model/json-schema-release.js";
import type { JsonSchemaReleaseInspector } from "../ports/json-schema-release-inspector.js";
import { evaluateJsonSchemaRelease } from "../policies/evaluate-json-schema-release.js";

export async function verifyJsonSchemaRelease(
  input: {
    readonly consumerRoot: string;
    readonly policy: JsonSchemaReleasePolicy;
    readonly signal?: AbortSignal;
  },
  inspector: JsonSchemaReleaseInspector
): Promise<{
  readonly observation: JsonSchemaInspection;
  readonly diagnostics: readonly import("../../../../check-contract.js").FoundationDiagnostic[];
}> {
  const observation = await inspector.inspect({
    consumerRoot: input.consumerRoot,
    schemaPaths: input.policy.schemaPaths,
    fixtures: input.policy.fixtures,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  return Object.freeze({
    observation,
    diagnostics: evaluateJsonSchemaRelease(input.policy, observation)
  });
}
