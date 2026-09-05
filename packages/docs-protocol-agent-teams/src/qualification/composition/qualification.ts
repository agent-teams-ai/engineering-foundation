import {
  assertConsumerIntegrationProfileSchema,
  checkConsumerIntegration,
  observeQualifiedPnpmLockfileV2,
  projectQualificationAuthorityV2
} from "../../consumer-integration/composition/qualification-v3-boundary.js";
import { createDocsProtocolQualificationV2 } from "../adapters/outbound/node-managed-qualification.js";
import {
  createDocsProtocolQualificationV3Observer,
  createDocsProtocolQualificationV3,
  type DocsProtocolQualificationV2Request,
  type DocsProtocolQualificationReceiptV2,
  type DocsProtocolQualificationV3Request,
  type DocsProtocolQualificationReceiptV3,
  type DocsProtocolQualificationLockfileObservationV3,
  type DocsProtocolQualificationLockfileObservationV3Request,
  type DocsProtocolQualificationAuthorityV3,
  type DocsProtocolQualificationAuthorityV3Request
} from "../application-api.js";

const observeLockfile =
  createDocsProtocolQualificationV3Observer(observeQualifiedPnpmLockfileV2);
const qualification = {
  runDocsProtocolQualificationV2: createDocsProtocolQualificationV2({
    assertProfile: assertConsumerIntegrationProfileSchema,
    check: checkConsumerIntegration
  }),
  observeDocsProtocolQualificationV3Lockfile: observeLockfile,
  runDocsProtocolQualificationV3: createDocsProtocolQualificationV3(observeLockfile)
};

export function projectDocsProtocolQualificationV3Authority(
  request: DocsProtocolQualificationAuthorityV3Request
): DocsProtocolQualificationAuthorityV3 {
  return projectQualificationAuthorityV2(request);
}

export function runDocsProtocolQualificationV2(
  request: DocsProtocolQualificationV2Request
): Promise<DocsProtocolQualificationReceiptV2> {
  return qualification.runDocsProtocolQualificationV2(request);
}

export function observeDocsProtocolQualificationV3Lockfile(
  request: DocsProtocolQualificationLockfileObservationV3Request
): DocsProtocolQualificationLockfileObservationV3 {
  return qualification.observeDocsProtocolQualificationV3Lockfile(request);
}

export function runDocsProtocolQualificationV3(
  request: DocsProtocolQualificationV3Request
): DocsProtocolQualificationReceiptV3 {
  return qualification.runDocsProtocolQualificationV3(request);
}
