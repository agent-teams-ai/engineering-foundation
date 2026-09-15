import { assertNotCancelled, capabilityReport } from "../../../../features/validation-reporting/api.js";
import type { CapabilityReport } from "../../../../features/validation-reporting/api.js";
import type { SdkGrowthCapabilityPolicy } from "../model/growth-configuration.js";
import type { GrowthInputContextPort } from "../ports/growth-input-context.js";
import type { GrowthReportWriter } from "../ports/growth-report-writer.js";
import { GrowthReportWriteError } from "../ports/growth-report-writer.js";
import type { PublicApiRepository } from "../ports/public-api-repository.js";
import { growthCanonicalJson } from "../policies/normalize-growth-observation.js";
import { createGrowthObservation } from "./observe-sdk-growth.js";
import { admitSdkGrowth } from "./admit-sdk-growth.js";

/** Existing capability route, one S1 execution and the unchanged release
 * comparator. Persistence owns the final cancellation boundary. */
export async function checkSdkGrowth(input: {
  readonly consumerRoot: string;
  readonly policy: SdkGrowthCapabilityPolicy;
  readonly signal?: AbortSignal;
}, dependencies: Parameters<typeof createGrowthObservation>[1] & {
  readonly context: GrowthInputContextPort;
  readonly writer: GrowthReportWriter;
  readonly repository: PublicApiRepository;
}): Promise<CapabilityReport> {
  const cancellation = { ...(input.signal === undefined ? {} : { signal: input.signal }),
    throwIfCancelled() { assertNotCancelled(input.signal); } };
  cancellation.throwIfCancelled();
  const config = structuredClone(input.policy);
  const subjects = [];
  for (const policy of config.compatibility.packages) {
    const release = await dependencies.repository.readReleaseEvidence(input.consumerRoot, config.compatibility.changesetDirectory, policy, input.signal);
    subjects.push({ policy, packageVersion: release.packageVersion });
  }
  const observation = createGrowthObservation({ consumerRoot: input.consumerRoot,
    workspaceManifestPath: config.sdkGrowth.workspaceManifestPath, subjects }, dependencies);
  const execution = await admitSdkGrowth({ invocation: config.sdkGrowth.invocation, context: config.sdkGrowth.context, cancellation },
    { observation, context: dependencies.context, fingerprint: dependencies.fingerprint });
  const payload = { reportVersion: 1, operation: "sdk-growth", releaseEligible: false,
    completedPhases: ["observation", "context", "admission", "release-compatibility"],
    invocation: config.sdkGrowth.invocation, ...execution };
  let publication;
  try {
    publication = await dependencies.writer.write({ path: config.sdkGrowth.report.path,
      expectedPreimage: config.sdkGrowth.report.expectedPreimage, contents: `${growthCanonicalJson(payload)}\n` }, cancellation);
  } catch (error) {
    if (!(error instanceof GrowthReportWriteError)) { throw error; }
    return capabilityReport({ capabilityId: "package.public-api-compatibility", capabilityConfigSchemaVersion: 2, outcome: "failed",
      problem: { code: `SDK_GROWTH_REPORT_${error.kind.toUpperCase()}`, message: error.reason,
        phase: "sdk-growth-report-publication", retryable: error.kind === "uncertain" } });
  }
  const status = execution.admission.status;
  return capabilityReport({ capabilityId: "package.public-api-compatibility", capabilityConfigSchemaVersion: 2,
    outcome: status === "admitted" ? "passed" : status === "rejected" ? "violations" : "invalid-input",
    ...(status === "incomplete" ? { problem: { code: "SDK_GROWTH_INCOMPLETE", message: "SDK evidence is incomplete; no trusted admission or release authority is established.",
      phase: "sdk-growth-admission", retryable: false } } : {}),
    diagnostics: [...execution.compatibility.diagnostics, {
      ruleId: "package.public-api-compatibility.sdk-growth-report", severity: "info", subject: "sdk-growth",
      message: `SDK growth ${status}; report ${publication.digest}.`, location: { path: config.sdkGrowth.report.path }, relatedLocations: [],
      evidence: [{ kind: "report-digest", value: publication.digest }, { kind: "admission-status", value: status }, { kind: "release-eligible", value: "false" }],
      remediation: "Inspect the SDK report's exact transitions, decision diagnostics and incomplete reasons. Filesystem inputs never establish trusted authority.",
      requiresArchitectureReview: false
    }] });
}
