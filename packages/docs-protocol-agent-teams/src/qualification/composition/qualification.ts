import { readFileSync } from "node:fs";

import { interruptAndRecover } from "@agent-teams/docs-protocol/qualification";
import {
  assertConsumerIntegrationProfileSchema,
  checkConsumerIntegration,
  observeQualifiedPnpmLockfileV2,
  projectQualificationAuthorityV2
} from "../../consumer-integration/composition/qualification-v3-boundary.js";
import { createNodeManagedQualificationEnvironment } from "../adapters/outbound/node-managed-qualification.js";
import { createNodeDocsProtocolQualificationRuntimeObserver } from
  "../adapters/outbound/node-qualification-runtime.js";
import { evaluateManagedRestorationLockV1 } from "../adapters/outbound/restoration-lock-graph.js";
import {
  type ManagedRestorationLockV1Request,
  type ManagedRestorationLockV1Result,
  createDocsProtocolQualificationV2,
  createDocsProtocolQualificationV3Observer,
  createDocsProtocolQualificationV3,
  type DocsProtocolQualificationV2Request,
  type DocsProtocolQualificationReceiptV2,
  type DocsProtocolQualificationV3Request,
  type DocsProtocolQualificationReceiptV3,
  type DocsProtocolQualificationCohortV3Request,
  type DocsProtocolQualificationCohortV3Receipt,
  type DocsProtocolQualificationLockfileObservationV3,
  type DocsProtocolQualificationLockfileObservationV3Request,
  type DocsProtocolQualificationAuthorityV3,
  type DocsProtocolQualificationAuthorityV3Request
} from "../application-api.js";
import type { PackedManagedRuntimePolicy } from
  "../../consumer-integration/application-api.js";

function readPackedManagedRuntimePolicy(): PackedManagedRuntimePolicy {
  const source = readFileSync(new URL("../../../assets/runtime-policy.v1.json", import.meta.url), "utf8");
  if (Buffer.byteLength(source, "utf8") > 64 * 1024) {
    throw new TypeError("Packed managed runtime policy exceeds its bounded size.");
  }
  const asset: unknown = JSON.parse(source);
  if (typeof asset !== "object" || asset === null || Array.isArray(asset)) {
    throw new TypeError("Packed managed runtime policy must be one object.");
  }
  const record = asset as Record<string, unknown>;
  const managedRuntime = record["managedRuntime"];
  const lanes = typeof managedRuntime === "object" && managedRuntime !== null &&
    !Array.isArray(managedRuntime)
    ? (managedRuntime as Record<string, unknown>)["lanes"]
    : undefined;
  if (record["schemaVersion"] !== 1 ||
    record["policyId"] !== "agent-teams.docs-protocol-current-policy" ||
    record["policyVersion"] !== "3.0.0" ||
    typeof record["sourceDigest"] !== "string" ||
    typeof managedRuntime !== "object" || managedRuntime === null || Array.isArray(managedRuntime) ||
    (managedRuntime as Record<string, unknown>)["status"] !== "candidate-unqualified" ||
    typeof (managedRuntime as Record<string, unknown>)["pnpm"] !== "string" ||
    typeof lanes !== "object" || lanes === null || Array.isArray(lanes) ||
    Object.keys(lanes).toSorted().join("\u0000") !==
      ["node-24-production-default", "node-26-managed-qualified"].toSorted().join("\u0000")) {
    throw new TypeError("Packed managed runtime policy identity is invalid.");
  }
  return {
    policyId: "agent-teams.docs-protocol-current-policy",
    policyVersion: "3.0.0",
    sourceDigest: record["sourceDigest"],
    pnpm: (managedRuntime as Record<string, unknown>)["pnpm"] as string,
    lanes: lanes as PackedManagedRuntimePolicy["lanes"]
  };
}

const observeLockfile =
  createDocsProtocolQualificationV3Observer(observeQualifiedPnpmLockfileV2);
const observeNodeRuntime = createNodeDocsProtocolQualificationRuntimeObserver();
const qualificationEnvironment = createNodeManagedQualificationEnvironment(interruptAndRecover);
const qualification = {
  runDocsProtocolQualificationV2: createDocsProtocolQualificationV2({
    integrationApi: {
      assertProfile: assertConsumerIntegrationProfileSchema,
      check: checkConsumerIntegration
    },
    environment: qualificationEnvironment
  }),
  observeDocsProtocolQualificationV3Lockfile: observeLockfile,
  runDocsProtocolQualificationV3: createDocsProtocolQualificationV3(
    observeLockfile,
    observeNodeRuntime,
    readPackedManagedRuntimePolicy()
  )
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
): DocsProtocolQualificationReceiptV3;
export function runDocsProtocolQualificationV3(
  request: DocsProtocolQualificationCohortV3Request
): DocsProtocolQualificationCohortV3Receipt;
export function runDocsProtocolQualificationV3(
  request: DocsProtocolQualificationV3Request | DocsProtocolQualificationCohortV3Request
): DocsProtocolQualificationReceiptV3 | DocsProtocolQualificationCohortV3Receipt {
  return qualification.runDocsProtocolQualificationV3(request);
}

export function checkManagedRestorationLockV1(
  request: ManagedRestorationLockV1Request
): ManagedRestorationLockV1Result {
  return evaluateManagedRestorationLockV1(request);
}
