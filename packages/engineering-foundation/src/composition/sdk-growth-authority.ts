import { assertSchema } from "../schema-catalog.js";
import { readContainedRegularFile } from "../source-inventory/node.js";
import { AjvJsonSchemaReleaseInspector } from "../capabilities/contract-json-schema-releases/module.js";
import { readAcceptedArchitectureDecisionEvidence } from "../capabilities/governance-architecture-decisions/module.js";
import type { SdkGrowthAuthorityTransport } from "../capabilities/public-api-compatibility/adapters/inbound/authority/growth-authority-contract.js";
import { createSdkGrowthAuthorityModule } from "../capabilities/public-api-compatibility/authority-module.js";

const readAcceptedDecisions = (input: Parameters<typeof readAcceptedArchitectureDecisionEvidence>[0]) =>
  readAcceptedArchitectureDecisionEvidence(input, assertSchema);

/** Curated composition for a trusted host. Consumer configuration cannot
 * select or replace the supplied transport. */
export function createSdkGrowthAuthorityVerifier(transport: SdkGrowthAuthorityTransport) {
  return createSdkGrowthAuthorityModule({
    transport,
    readAcceptedDecisions,
    assertSchema,
    inspector: new AjvJsonSchemaReleaseInspector({ read: readContainedRegularFile })
  });
}
