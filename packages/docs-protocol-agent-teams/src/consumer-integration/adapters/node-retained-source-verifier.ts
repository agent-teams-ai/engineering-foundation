import type { ConsumerIntegrationDesiredStateV3 } from "../domain/model.js";
import type { ConsumerIntegrationLifecyclePorts } from "../application/use-cases/run-consumer-integration.js";
import { compileConsumerIntegration } from "../application/use-cases/plan-consumer-integration.js";
import { canonicalConsumerIntegrationJson } from "../application/policies/consumer-integration-assets.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";

export type RetainedGeneration2SourceVerifier = (options: {
  readonly consumerRoot: string;
  readonly current: ConsumerIntegrationDesiredStateV3;
}) => Promise<void>;

/** Observes source data with the retained controller; never loads consumer executable code. */
export function createRetainedGeneration2SourceVerifier(
  ports: Pick<ConsumerIntegrationLifecyclePorts, "input" | "assets" | "planning">,
): RetainedGeneration2SourceVerifier {
  return async (options) => {
    const input = await ports.input.read({ consumerRoot: options.consumerRoot });
    if (
      input.desired.schemaVersion !== 3 ||
      canonicalConsumerIntegrationJson(input.desired) !==
        canonicalConsumerIntegrationJson(options.current)
    ) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_UPGRADE_SOURCE_NOT_CURRENT",
        "Retained source observation differs from the selected original profile and Cohort.",
      );
    }
    const { plan } = compileConsumerIntegration(
      {
        desired: input.desired,
        snapshot: input.snapshot,
        assetCatalog: await ports.assets.read(),
      },
      ports.planning,
    );
    if (plan.outcome !== "current") {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_UPGRADE_SOURCE_NOT_CURRENT",
        "Retained controller did not observe the restored original Cohort as current.",
      );
    }
  };
}
