import {
  type ConsumerIntegrationDesiredStateV1,
  type ConsumerIntegrationDesiredStateV3,
  type ConsumerUpgradeAuthorityV1,
  type ConsumerUpgradeAuthorityV2,
} from "../application-api.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import { projectPnpmManifestCohortPinsV1 } from "./pnpm-manifest-adapter-v1.js";
import { projectPnpmManifestCohortPinsV2 } from "./pnpm-manifest-adapter-v2.js";
import {
  projectConsumerIntegrationProfileV1,
  projectConsumerIntegrationProfileV3,
  migrateHistoricalConsumerIntegrationProfileToV3,
  projectPnpmWorkspaceCohortExclusionsV1,
  projectPnpmWorkspaceMigrationExclusionsV1,
  projectPnpmWorkspaceCohortExclusionsV2,
  projectPnpmWorkspaceMigrationExclusionsV2,
  projectPnpmWorkspaceMigrationExclusionsV1ToV2,
} from "./consumer-upgrade-projector-support.js";
export {
  projectConsumerIntegrationProfileV1,
  projectConsumerIntegrationProfileV3,
  projectPnpmWorkspaceCohortExclusionsV1,
  projectPnpmWorkspaceMigrationExclusionsV1,
  projectPnpmWorkspaceCohortExclusionsV2,
  projectPnpmWorkspaceMigrationExclusionsV2,
  projectManagedPortableProfileV4,
} from "./consumer-upgrade-projector-support.js";
export type ConsumerUpgradeFileProjectionInput =
  | {
      readonly authority: ConsumerUpgradeAuthorityV2;
      readonly current: ConsumerIntegrationDesiredStateV1;
      readonly manifest: Uint8Array;
      readonly profile: Uint8Array;
      readonly workspace?: Uint8Array;
    }
  | {
      readonly authority: ConsumerUpgradeAuthorityV1;
      readonly current: ConsumerIntegrationDesiredStateV1;
      readonly manifest: Uint8Array;
      readonly profile: Uint8Array;
      readonly workspace?: Uint8Array;
    }
  | {
      readonly authority: ConsumerUpgradeAuthorityV2;
      readonly current: ConsumerIntegrationDesiredStateV3;
      readonly manifest: Uint8Array;
      readonly profile: Uint8Array;
      readonly workspace?: Uint8Array;
    };

export interface ConsumerUpgradeFileProjection {
  readonly manifest: Uint8Array;
  readonly migrationWorkspace?: Uint8Array;
  readonly profile: Uint8Array;
  readonly targetWorkspace?: Uint8Array;
}

export async function projectConsumerUpgradeFiles(
  input: ConsumerUpgradeFileProjectionInput,
): Promise<ConsumerUpgradeFileProjection> {
  if (input.current.schemaVersion === 1 && input.authority.cohort.schemaVersion === 1) {
    const targetWorkspace =
      input.workspace === undefined
        ? undefined
        : projectPnpmWorkspaceCohortExclusionsV1({
            bytes: input.workspace,
            cohort: input.authority.cohort,
          });
    return {
      profile: await projectConsumerIntegrationProfileV1({
        bytes: input.profile,
        cohort: input.authority.cohort,
      }),
      manifest: projectPnpmManifestCohortPinsV1({
        bytes: input.manifest,
        cohort: input.authority.cohort,
      }),
      ...(targetWorkspace === undefined
        ? {}
        : {
            targetWorkspace,
            migrationWorkspace: projectPnpmWorkspaceMigrationExclusionsV1({
              bytes: input.workspace!,
              source: input.current.cohort,
              target: input.authority.cohort,
            }),
          }),
    };
  }
  if (input.current.schemaVersion === 3 && input.authority.cohort.schemaVersion === 2) {
    const targetWorkspace =
      input.workspace === undefined
        ? undefined
        : projectPnpmWorkspaceCohortExclusionsV2({
            bytes: input.workspace,
            cohort: input.authority.cohort,
          });
    return {
      profile: await projectConsumerIntegrationProfileV3({
        bytes: input.profile,
        cohort: input.authority.cohort,
      }),
      manifest: projectPnpmManifestCohortPinsV2({
        bytes: input.manifest,
        cohort: input.authority.cohort,
      }),
      ...(targetWorkspace === undefined
        ? {}
        : {
            targetWorkspace,
            migrationWorkspace: projectPnpmWorkspaceMigrationExclusionsV2({
              bytes: input.workspace!,
              source: input.current.cohort,
              target: input.authority.cohort,
            }),
          }),
    };
  }
  if (input.current.schemaVersion === 1 && input.authority.cohort.schemaVersion === 2) {
    const targetWorkspace =
      input.workspace === undefined
        ? undefined
        : projectPnpmWorkspaceCohortExclusionsV2({
            bytes: input.workspace,
            cohort: input.authority.cohort,
          });
    return {
      profile: await migrateHistoricalConsumerIntegrationProfileToV3({
        bytes: input.profile,
        cohort: input.authority.cohort,
      }),
      manifest: projectPnpmManifestCohortPinsV2({
        bytes: input.manifest,
        cohort: input.authority.cohort,
      }),
      ...(targetWorkspace === undefined
        ? {}
        : {
            targetWorkspace,
            migrationWorkspace: projectPnpmWorkspaceMigrationExclusionsV1ToV2({
              bytes: input.workspace!,
              source: input.current.cohort,
              target: input.authority.cohort,
            }),
          }),
    };
  }
  throw new ConsumerIntegrationNodeError(
    "DOCS_CONSUMER_UPGRADE_GENERATION_MISMATCH",
    "Cross-generation consumer file projection is forbidden.",
  );
}

/** Returns reviewable bytes only; Cohort upgrades never invoke this optional migration. */
