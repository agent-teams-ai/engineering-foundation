import { validateGrowthReport } from "../policies/validate-growth-report.js";
import { projectGrowthReport } from "../policies/project-growth-report.js";
import { GrowthObservationInvariantError } from "../model/growth-observation.js";
import type { GrowthCancellation, GrowthInvocation } from "../model/growth-observation.js";
import { assertNotCancelled, capabilityReport } from "../../../../features/validation-reporting/api.js";
import type { CapabilityReport } from "../../../../features/validation-reporting/api.js";
import type { SdkGrowthCapabilityPolicy } from "../model/growth-configuration.js";
import type { GrowthReport } from "../model/growth-report.js";
import type { GrowthInputContextPort } from "../ports/growth-input-context.js";
import type { GrowthReportWriter } from "../ports/growth-report-writer.js";
import { GrowthReportWriteError } from "../ports/growth-report-writer.js";
import type { PublicApiRepository } from "../ports/public-api-repository.js";
import { growthCanonicalJson } from "../policies/normalize-growth-observation.js";
import { createGrowthObservation } from "./observe-sdk-growth.js";
import { admitSdkGrowth } from "./admit-sdk-growth.js";

/** Existing capability route, one S1 execution and the unchanged release
 * comparator. Persistence owns the final cancellation boundary. */
export interface SdkGrowthCheckExecution {
  readonly capability: CapabilityReport;
  readonly report?: GrowthReport;
  readonly reportDigest?: import("../model/growth-observation.js").GrowthDigest;
  readonly reportByteLength?: number;
}

export async function executeSdkGrowth(input: {
  readonly consumerRoot: string;
  readonly policy: SdkGrowthCapabilityPolicy;
  readonly invocation: GrowthInvocation;
  readonly signal?: AbortSignal;
}, dependencies: Parameters<typeof createGrowthObservation>[1] & {
  readonly context: GrowthInputContextPort;
  readonly observationBoundary?: (local: import("../ports/growth-observation.js").GrowthObservationPort) => import("../ports/growth-observation.js").GrowthObservationPort;
  readonly writer: GrowthReportWriter;
  readonly repository: PublicApiRepository;
  readonly readInvocation: (cancellation: GrowthCancellation) => Promise<GrowthInvocation>;
}): Promise<SdkGrowthCheckExecution> {
  const cancellation = { ...(input.signal === undefined ? {} : { signal: input.signal }),
    throwIfCancelled() { assertNotCancelled(input.signal); } };
  cancellation.throwIfCancelled();
  const config = structuredClone(input.policy);
  const invocation = structuredClone(input.invocation);
  const subjects = [];
  for (const policy of config.compatibility.packages) {
    const release = await dependencies.repository.readReleaseEvidence(input.consumerRoot, config.compatibility.changesetDirectory, policy, input.signal);
    subjects.push({ policy, packageVersion: release.packageVersion });
  }
  const observation = createGrowthObservation({ consumerRoot: input.consumerRoot,
    workspaceManifestPath: "pnpm-workspace.yaml", subjects }, dependencies);
  const execution = await admitSdkGrowth({ invocation, context: { ...config.sdkGrowth.comparison, decisionsPath: config.sdkGrowth.decisionsPath }, cancellation },
    { observation: dependencies.observationBoundary?.(observation) ?? observation, context: dependencies.context, fingerprint: dependencies.fingerprint });
  const finalInvocation = await dependencies.readInvocation(cancellation);
  if (growthCanonicalJson(finalInvocation) !== growthCanonicalJson(invocation)) {
    throw new GrowthObservationInvariantError("growth-execution-inputs-changed");
  }
  const payload = validateGrowthReport(projectGrowthReport(execution, dependencies.fingerprint,
    config.compatibility.packages.map((policy) => policy.packageName)), dependencies.fingerprint);
  let publication;
  try {
    publication = await dependencies.writer.write({ path: config.sdkGrowth.reportPath,
      contents: `${growthCanonicalJson(payload)}\n` }, cancellation);
  } catch (error) {
    if (!(error instanceof GrowthReportWriteError)) { throw error; }
    return { capability: capabilityReport({ capabilityId: "package.public-api-compatibility", capabilityConfigSchemaVersion: 2, outcome: "failed",
      problem: { code: `SDK_GROWTH_REPORT_${error.kind.toUpperCase()}`, message: error.reason,
        phase: "sdk-growth-report-publication", retryable: error.kind === "uncertain" } }) };
  }
  const status = payload.verdict;
  const capability = capabilityReport({ capabilityId: "package.public-api-compatibility", capabilityConfigSchemaVersion: 2,
    outcome: status === "admitted" ? "passed" : status === "rejected" ? "violations" : "invalid-input",
    ...(status === "incomplete" ? { problem: { code: "SDK_GROWTH_EVIDENCE_INCOMPLETE", message: "SDK evidence is incomplete; no trusted admission or release authority is established.",
      phase: "sdk-growth-evidence", retryable: false } } : {}),
    diagnostics: [...execution.compatibility.diagnostics, ...execution.admission.diagnostics.map((diagnostic) => ({
      ruleId: `package.public-api-compatibility.${diagnostic.code}`, severity: "error" as const,
      subject: diagnostic.subject, message: diagnostic.code, location: { path: config.sdkGrowth.decisionsPath }, relatedLocations: [],
      evidence: [], remediation: diagnostic.remediation, requiresArchitectureReview: false
    })), {
      ruleId: "package.public-api-compatibility.sdk-growth-report", severity: "info", subject: payload.repository,
      message: `SDK growth ${status}; report ${publication.digest}.`, location: { path: config.sdkGrowth.reportPath }, relatedLocations: [],
      evidence: [{ kind: "sdk-growth-report-path", value: config.sdkGrowth.reportPath }, { kind: "sdk-growth-report-digest", value: publication.digest },
        { kind: "sdk-growth-contract-revision", value: payload.contractRevision }],
      remediation: "Inspect the SDK report's exact transitions, decision diagnostics and incomplete reasons. Filesystem inputs never establish trusted authority.",
      requiresArchitectureReview: false
    }] });
  return { capability, report: payload, reportDigest: publication.digest,
    reportByteLength: Buffer.byteLength(`${growthCanonicalJson(payload)}\n`, "utf8") };
}

export async function checkSdkGrowth(
  input: Parameters<typeof executeSdkGrowth>[0],
  dependencies: Parameters<typeof executeSdkGrowth>[1]
): Promise<CapabilityReport> {
  return (await executeSdkGrowth(input, dependencies)).capability;
}
