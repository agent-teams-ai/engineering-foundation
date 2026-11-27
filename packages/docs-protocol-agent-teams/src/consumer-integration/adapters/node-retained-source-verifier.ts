import type { ConsumerIntegrationDesiredStateV3 } from "../domain/model.js";
import type {
  ConsumerAssetCatalogReader,
  ConsumerIntegrationPlanningPorts,
} from "../application-api.js";
import type { RetainedGeneration2SourceInputReader } from "./node-consumer-integration-repository.js";
import { compileConsumerIntegration } from "../application/use-cases/plan-consumer-integration.js";
import { canonicalConsumerIntegrationJson } from "../application/policies/consumer-integration-assets.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";

export type RetainedGeneration2SourceVerifier = (options: {
  readonly consumerRoot: string;
  readonly current: ConsumerIntegrationDesiredStateV3;
  readonly sourceRevision?: string;
}) => Promise<void>;

/** Observes source data with the retained controller; never loads consumer executable code. */
export function createRetainedGeneration2SourceVerifier(ports: {
  readonly input: RetainedGeneration2SourceInputReader;
  readonly assets: ConsumerAssetCatalogReader;
  readonly planning: ConsumerIntegrationPlanningPorts;
}): RetainedGeneration2SourceVerifier {
  return async (options) => {
    const input =
      options.sourceRevision === undefined
        ? await ports.input.read({ consumerRoot: options.consumerRoot })
        : await ports.input.readRestored({
            consumerRoot: options.consumerRoot,
            sourceRevision: options.sourceRevision,
          });
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
