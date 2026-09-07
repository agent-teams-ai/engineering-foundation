import type { KnownFileTransactionOperationInput } from "@agent-teams/repository-mutation/known-file";

import type {
  ConsumerIntegrationFileObservation,
  ConsumerIntegrationSnapshot
} from "../../domain/model.js";

function guardOperation(
  path: string,
  observation: ConsumerIntegrationFileObservation
): KnownFileTransactionOperationInput {
  if (observation.state !== "file") {
    throw new TypeError(`Required consumer authority observation is absent: ${path}.`);
  }
  return {
    path,
    precondition: {
      state: "known-file",
      acceptedPreimages: [{ bytes: observation.bytes, mode: observation.mode }]
    },
    postimage: { bytes: observation.bytes, mode: observation.mode }
  };
}

export function consumerIntegrationAuthorityGuards(
  snapshot: ConsumerIntegrationSnapshot,
  hasManagedChanges: boolean
): readonly KnownFileTransactionOperationInput[] {
  if (!hasManagedChanges) {return [];}
  return [
    guardOperation(
      "architecture/foundation/docs-consumer-integration.json",
      snapshot.integrationProfile
    ),
    guardOperation("pnpm-lock.yaml", snapshot.lockfile)
  ];
}
