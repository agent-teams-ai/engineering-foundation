import { interruptAndRecover } from "@agent-teams/docs-protocol/qualification";
import {
  assertConsumerIntegrationProfileSchema,
  checkConsumerIntegration,
  createLazyPackedManagedRuntimePolicyObserver,
  observeQualifiedPnpmLockfileV2,
  projectQualificationAuthorityV2,
  projectQualificationAuthorityV3,
} from "../../consumer-integration/composition/qualification-v3-boundary.js";
import { createNodeManagedQualificationEnvironment } from "../adapters/outbound/node-managed-qualification.js";
import { createNodeDocsProtocolQualificationRuntimeObserver } from "../adapters/outbound/node-qualification-runtime.js";
import { evaluateManagedRestorationLockV1 } from "../adapters/outbound/restoration-lock-graph.js";
import { createNodeQualificationApi } from "../adapters/outbound/node-qualification-api-factory.js";
import type {
  DocsProtocolQualificationAuthorityV3,
  DocsProtocolQualificationAuthorityV3Request,
  DocsProtocolQualificationCohortV3Authority,
  DocsProtocolQualificationCohortV3AuthorityRequest,
  DocsProtocolQualificationCohortV3Receipt,
  DocsProtocolQualificationCohortV3Request,
  DocsProtocolQualificationLockfileObservationV3,
  DocsProtocolQualificationLockfileObservationV3Request,
  DocsProtocolQualificationReceiptV2,
  DocsProtocolQualificationReceiptV3,
  DocsProtocolQualificationV2Request,
  DocsProtocolQualificationV3Request,
  ManagedRestorationLockV1Request,
  ManagedRestorationLockV1Result,
} from "../application-api.js";
const observeNodeRuntime = createNodeDocsProtocolQualificationRuntimeObserver();
const qualificationEnvironment = createNodeManagedQualificationEnvironment(interruptAndRecover);
const qualification = createNodeQualificationApi({
  integrationApi: {
    assertProfile: assertConsumerIntegrationProfileSchema,
    check: checkConsumerIntegration,
  },
  environment: qualificationEnvironment,
  observeLockfile: observeQualifiedPnpmLockfileV2,
  observeRuntime: observeNodeRuntime,
  observePackedPolicy: createLazyPackedManagedRuntimePolicyObserver(),
  projectAuthority: projectQualificationAuthorityV2,
  projectCohortAuthority: projectQualificationAuthorityV3,
  evaluateRestorationLock: evaluateManagedRestorationLockV1,
});

export function projectDocsProtocolQualificationV3Authority(
  request: DocsProtocolQualificationAuthorityV3Request,
): DocsProtocolQualificationAuthorityV3 {
  return qualification.projectDocsProtocolQualificationV3Authority(request);
}

export function projectDocsProtocolQualificationCohortV3Authority(
  request: DocsProtocolQualificationCohortV3AuthorityRequest,
): DocsProtocolQualificationCohortV3Authority {
  return qualification.projectDocsProtocolQualificationCohortV3Authority(request);
}

export function runDocsProtocolQualificationV2(
  request: DocsProtocolQualificationV2Request,
): Promise<DocsProtocolQualificationReceiptV2> {
  return qualification.runDocsProtocolQualificationV2(request);
}

export function observeDocsProtocolQualificationV3Lockfile(
  request: DocsProtocolQualificationLockfileObservationV3Request,
): DocsProtocolQualificationLockfileObservationV3;
export function observeDocsProtocolQualificationV3Lockfile(
  request: Pick<DocsProtocolQualificationCohortV3Request, "profile" | "lockfileBytes">,
): DocsProtocolQualificationLockfileObservationV3;
export function observeDocsProtocolQualificationV3Lockfile(
  request:
    | DocsProtocolQualificationLockfileObservationV3Request
    | Pick<DocsProtocolQualificationCohortV3Request, "profile" | "lockfileBytes">,
): DocsProtocolQualificationLockfileObservationV3 {
  return qualification.observeDocsProtocolQualificationV3Lockfile(request);
}

export function runDocsProtocolQualificationV3(
  request: DocsProtocolQualificationV3Request,
): DocsProtocolQualificationReceiptV3;
export function runDocsProtocolQualificationV3(
  request: DocsProtocolQualificationCohortV3Request,
): DocsProtocolQualificationCohortV3Receipt;
export function runDocsProtocolQualificationV3(
  request: DocsProtocolQualificationV3Request | DocsProtocolQualificationCohortV3Request,
): DocsProtocolQualificationReceiptV3 | DocsProtocolQualificationCohortV3Receipt {
  return qualification.runDocsProtocolQualificationV3(request);
}

export function checkManagedRestorationLockV1(
  request: ManagedRestorationLockV1Request,
): ManagedRestorationLockV1Result {
  return qualification.checkManagedRestorationLockV1(request);
}
