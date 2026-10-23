import {
  createDocsProtocolQualificationV2,
  createDocsProtocolQualificationV3,
  createDocsProtocolQualificationV3Observer,
  type DocsProtocolQualificationAuthorityV3,
  type DocsProtocolQualificationAuthorityV3Request,
  type DocsProtocolQualificationCohortV3Authority,
  type DocsProtocolQualificationCohortV3AuthorityRequest,
  type DocsProtocolQualificationCohortV3Receipt,
  type DocsProtocolQualificationCohortV3Request,
  type DocsProtocolQualificationLockfileObservationV3,
  type DocsProtocolQualificationLockfileObservationV3Request,
  type DocsProtocolQualificationReceiptV2,
  type DocsProtocolQualificationReceiptV3,
  type DocsProtocolQualificationV2Request,
  type DocsProtocolQualificationV3Request,
  type ManagedRestorationLockV1Request,
  type ManagedRestorationLockV1Result,
} from "../../application-api.js";

type QualificationV2Dependencies = Parameters<typeof createDocsProtocolQualificationV2>[0];
type QualificationV3LockfileObserver = Parameters<
  typeof createDocsProtocolQualificationV3Observer
>[0];
type QualificationV3RuntimeObserver = Parameters<typeof createDocsProtocolQualificationV3>[1];
type QualificationV3PolicyObserver = Parameters<typeof createDocsProtocolQualificationV3>[2];
type QualificationV3LockfileRequest =
  | DocsProtocolQualificationLockfileObservationV3Request
  | Pick<DocsProtocolQualificationCohortV3Request, "profile" | "lockfileBytes">;
type QualificationV3Request =
  | DocsProtocolQualificationV3Request
  | DocsProtocolQualificationCohortV3Request;

export interface NodeQualificationApiDependencies {
  readonly integrationApi: QualificationV2Dependencies["integrationApi"];
  readonly environment: QualificationV2Dependencies["environment"];
  readonly observeLockfile: QualificationV3LockfileObserver;
  readonly observeRuntime: QualificationV3RuntimeObserver;
  readonly observePackedPolicy: QualificationV3PolicyObserver;
  readonly projectAuthority: (
    request: DocsProtocolQualificationAuthorityV3Request,
  ) => DocsProtocolQualificationAuthorityV3;
  readonly projectCohortAuthority: (
    request: DocsProtocolQualificationCohortV3AuthorityRequest,
  ) => DocsProtocolQualificationCohortV3Authority;
  readonly evaluateRestorationLock: (
    request: ManagedRestorationLockV1Request,
  ) => ManagedRestorationLockV1Result;
}

export interface NodeQualificationApi {
  projectDocsProtocolQualificationV3Authority(
    request: DocsProtocolQualificationAuthorityV3Request,
  ): DocsProtocolQualificationAuthorityV3;
  projectDocsProtocolQualificationCohortV3Authority(
    request: DocsProtocolQualificationCohortV3AuthorityRequest,
  ): DocsProtocolQualificationCohortV3Authority;
  runDocsProtocolQualificationV2(
    request: DocsProtocolQualificationV2Request,
  ): Promise<DocsProtocolQualificationReceiptV2>;
  observeDocsProtocolQualificationV3Lockfile(
    request: QualificationV3LockfileRequest,
  ): DocsProtocolQualificationLockfileObservationV3;
  runDocsProtocolQualificationV3(
    request: QualificationV3Request,
  ): DocsProtocolQualificationReceiptV3 | DocsProtocolQualificationCohortV3Receipt;
  checkManagedRestorationLockV1(
    request: ManagedRestorationLockV1Request,
  ): ManagedRestorationLockV1Result;
}

export function createNodeQualificationApi(
  dependencies: NodeQualificationApiDependencies,
): NodeQualificationApi {
  const runV2 = createDocsProtocolQualificationV2({
    integrationApi: dependencies.integrationApi,
    environment: dependencies.environment,
  });
  const observeLockfile = createDocsProtocolQualificationV3Observer(dependencies.observeLockfile);
  const runV3 = createDocsProtocolQualificationV3(
    observeLockfile,
    dependencies.observeRuntime,
    dependencies.observePackedPolicy,
  );
  const observeDocsProtocolQualificationV3Lockfile: (
    request: QualificationV3LockfileRequest,
  ) => DocsProtocolQualificationLockfileObservationV3 = observeLockfile;
  const runDocsProtocolQualificationV3: (
    request: QualificationV3Request,
  ) => DocsProtocolQualificationReceiptV3 | DocsProtocolQualificationCohortV3Receipt = runV3;
  return Object.freeze({
    projectDocsProtocolQualificationV3Authority: dependencies.projectAuthority,
    projectDocsProtocolQualificationCohortV3Authority: dependencies.projectCohortAuthority,
    runDocsProtocolQualificationV2: runV2,
    observeDocsProtocolQualificationV3Lockfile,
    runDocsProtocolQualificationV3,
    checkManagedRestorationLockV1: dependencies.evaluateRestorationLock,
  });
}
