import type { PublicApiSchemaAssertion } from "../../schema-validation.js";
import type {
  GrowthAuthorityBinding,
  GrowthAuthorityGrant,
  GrowthAuthorityReleasedEvidence,
  GrowthAuthorityRequest,
  ResolvedGrowthAuthority
} from "../../../application/model/growth-authority.js";
import { growthAuthorityRequiredPhases, growthAuthoritySchemaVersion } from "../../../application/model/growth-authority.js";
import type { GrowthContextRequest, GrowthInputContext, GrowthReleasedPackage } from "../../../application/model/growth-admission-context.js";
import type { GrowthCancellation, GrowthDigest } from "../../../application/model/growth-observation.js";
import { GrowthObservationInvariantError } from "../../../application/model/growth-observation.js";
import type { GrowthAuthorityPort } from "../../../application/ports/growth-authority.js";
import type { GrowthInputContextPort } from "../../../application/ports/growth-input-context.js";
import type { ChangeFingerprint } from "../../../application/ports/change-fingerprint.js";
import { hashGrowthPayload } from "../../../application/policies/compare-growth-surfaces.js";
import { growthCanonicalJson, growthObservationReference, growthUniqueSorted } from "../../../application/policies/normalize-growth-observation.js";
import { growthAuthorityGrantDigest, growthAuthorityRequestDigest, validateGrowthAuthorityBinding } from "../../../application/policies/validate-growth-authority.js";

function invalid(reason: string): never { throw new GrowthObservationInvariantError(reason); }
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) { invalid("growth-authority-context-invalid"); }
  return value as Record<string, unknown>;
}
function digest(value: unknown): GrowthDigest {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) { invalid("growth-authority-context-digest-invalid"); }
  return value as GrowthDigest;
}

async function mapReleasedPackage(input: {
  readonly row: GrowthAuthorityReleasedEvidence;
  readonly candidate: GrowthInputContext;
  readonly grant: GrowthAuthorityGrant;
  readonly assertSchema: PublicApiSchemaAssertion;
}): Promise<GrowthReleasedPackage> {
  const { row, candidate, grant } = input;
  closed(row, ["packageName", "releaseEvidence", ...(row.observation === undefined ? [] : ["observation"]), "evidence"]);
  const local = candidate.released.find((entry) => entry.packageName === row.packageName) ?? invalid("growth-authority-release-policy-missing");
  if (!grant.archives.some((entry) => entry.packageName === row.packageName && entry.packageVersion === row.releaseEvidence.packageVersion)) {
    invalid("growth-authority-archive-missing");
  }
  const common = { packageName: row.packageName, policy: local.policy,
    releaseEvidence: { status: "available" as const, value: structuredClone(row.releaseEvidence) },
    ...(row.observation === undefined ? {} : { observation: { status: "available" as const, value: structuredClone(row.observation) } }) };
  if (row.evidence.kind === "released") {
    closed(row.evidence, ["kind", "typed", "artifact"]);
    await input.assertSchema("package-public-api-baseline/v1", row.evidence.typed, "sdk-growth-authority-typed");
    await input.assertSchema("package-public-api-baseline/v1", row.evidence.artifact, "sdk-growth-authority-artifact");
    return { ...common, evidence: { kind: "released", typed: { status: "available", value: structuredClone(row.evidence.typed) },
      artifact: { status: "available", value: structuredClone(row.evidence.artifact) } } };
  }
  closed(row.evidence, ["kind", "historyDigest"]);
  const historyDigest = digest(row.evidence.historyDigest);
  if (historyDigest !== grant.binding.historyDigest) { invalid("growth-authority-initial-history-mismatch"); }
  return { ...common, evidence: { kind: "initial-unreleased", history: { status: "available", value: historyDigest } } };
}

/** Trusted context injection keeps candidate parsing/rejection in the original
 * filesystem adapter while replacing every authority-bearing fact with exact
 * authenticated grant content. */
export class VerifiedGrowthInputContext implements GrowthInputContextPort {
  #resolved: ResolvedGrowthAuthority | undefined;

  constructor(private readonly dependencies: {
    readonly candidate: GrowthInputContextPort;
    readonly authority: GrowthAuthorityPort;
    readonly binding: GrowthAuthorityBinding;
    readonly operation: GrowthAuthorityRequest["operation"];
    readonly admissionReceiptId?: string;
    readonly fingerprint: ChangeFingerprint;
    readonly assertSchema: PublicApiSchemaAssertion;
  }) {}

  resolution(): ResolvedGrowthAuthority {
    return this.#resolved ?? invalid("growth-authority-not-resolved");
  }

  async read(selectors: GrowthContextRequest, cancellation: GrowthCancellation): Promise<GrowthInputContext> {
    if (this.#resolved !== undefined) { invalid("growth-authority-reused"); }
    const candidate = await this.dependencies.candidate.read(selectors, cancellation);
    cancellation.throwIfCancelled();
    const binding = validateGrowthAuthorityBinding(this.dependencies.binding);
    const decisionDigests = growthUniqueSorted(candidate.decisions.map((decision) => hashGrowthPayload({
      domain: "reviewrouter:sdk-growth-authority:decision-proposal:1", decision
    }, this.dependencies.fingerprint)), (entry) => entry);
    const request: GrowthAuthorityRequest = { schemaVersion: growthAuthoritySchemaVersion, kind: "request",
      operation: this.dependencies.operation,
      admissionReceiptId: this.dependencies.operation === "check" ? null : this.dependencies.admissionReceiptId ?? invalid("growth-authority-admission-receipt-required"),
      binding, contextSelectors: structuredClone(selectors), decisionDigests,
      requiredPhases: growthAuthorityRequiredPhases };
    const grant = await this.dependencies.authority.resolve(request, cancellation);
    cancellation.throwIfCancelled();
    if (growthCanonicalJson(grant.binding.invocation) !== growthCanonicalJson(binding.invocation)) { invalid("growth-authority-invocation-mismatch"); }
    if (grant.binding.target.evaluation.commit !== binding.invocation.sourceCommit || grant.binding.target.evaluation.tree !== binding.invocation.sourceTree) {
      invalid("growth-authority-evaluation-mismatch");
    }
    if (grant.binding.tool.version !== binding.invocation.tool.version || grant.binding.tool.extractorVersion !== binding.invocation.tool.extractorVersion
      || grant.binding.tool.distributionDigest !== binding.invocation.tool.artifactDigest) { invalid("growth-authority-tool-binding-mismatch"); }
    const reference = growthObservationReference(grant.trustedBase, this.dependencies.fingerprint);
    if (growthCanonicalJson(reference) !== growthCanonicalJson(grant.trustedBaseReference)) { invalid("growth-authority-base-reference-mismatch"); }
    const selectorNames = growthUniqueSorted(selectors.released, (entry) => entry.packageName).map((entry) => entry.packageName);
    const releasedRows = growthUniqueSorted(grant.released, (entry) => entry.packageName);
    if (growthCanonicalJson(selectorNames) !== growthCanonicalJson(releasedRows.map((entry) => entry.packageName))) {
      invalid("growth-authority-release-scope-mismatch");
    }
    const released: GrowthReleasedPackage[] = [];
    for (const row of releasedRows) {
      released.push(await mapReleasedPackage({ row, candidate, grant, assertSchema: this.dependencies.assertSchema }));
    }
    const requestDigest = growthAuthorityRequestDigest(request, this.dependencies.fingerprint);
    const grantDigest = growthAuthorityGrantDigest(grant, this.dependencies.fingerprint);
    const context: GrowthInputContext = {
      trustedBase: { status: "available", value: grant.trustedBase }, trustedBaseReference: { status: "available", value: grant.trustedBaseReference },
      retainedHistory: { status: "available", value: { targetSurfaceDigest: grant.retainedHistory.targetSurfaceDigest,
        receiptDigest: grant.retainedHistory.receiptDigest } }, released, decisions: candidate.decisions,
      acceptedBreakingDecisions: { acceptedDecisionIds: candidate.acceptedBreakingDecisions.acceptedDecisionIds,
        acceptedDecisionPaths: candidate.acceptedBreakingDecisions.acceptedDecisionPaths,
        growthDecisionAuthority: { status: "available", value: growthUniqueSorted(grant.ownerEvidence.map((entry) => ({
          decisionId: entry.decisionId, ownerRef: entry.ownerRef, decisionDigest: entry.decisionDigest
        })), (entry) => entry.decisionId) } },
      authority: { status: "verified", receiptDigest: grantDigest, workflowRef: grant.workflowRef, runRef: grant.runRef }
    };
    this.#resolved = { request, requestDigest, grant, grantDigest, context };
    return structuredClone(context);
  }
}
