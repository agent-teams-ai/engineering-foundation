import type {
  GrowthAuthorityBinding, GrowthAuthorityCompletion, GrowthAuthorityGrant,
  GrowthAuthorityOwnerEvidence, GrowthAuthorityReceipt, GrowthAuthorityReleasedEvidence,
  GrowthAuthorityRepository, GrowthAuthorityRequest, GrowthAuthoritySource, GrowthPromotionPlan
} from "../model/growth-authority.js";
import { growthAuthorityRequiredPhases, growthAuthoritySchemaVersion } from "../model/growth-authority.js";
import type { GrowthDigest } from "../model/growth-observation.js";
import { GrowthObservationInvariantError } from "../model/growth-observation.js";
import type { GrowthReport } from "../model/growth-report.js";
import type { PublicApiSnapshot } from "../model/public-api.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import { hashGrowthPayload } from "./compare-growth-surfaces.js";
export { growthDecisionDigest } from "./evaluate-growth-admission.js";
import { growthCanonicalJson, growthObservationReference, growthUniqueSorted, normalizeGrowthInvocation, normalizeGrowthObservation } from "./normalize-growth-observation.js";

function invalid(reason: string): never { throw new GrowthObservationInvariantError(reason); }
function object(value: unknown, keys: readonly string[], reason = "growth-authority-contract-invalid"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) { invalid(reason); }
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 4096) { invalid("growth-authority-text-invalid"); }
  return value;
}
function digest(value: unknown): GrowthDigest {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) { invalid("growth-authority-digest-invalid"); }
  return value as GrowthDigest;
}
function commit(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) { invalid("growth-authority-source-invalid"); }
  return value;
}
function source(value: unknown): GrowthAuthoritySource {
  const row = object(value, ["commit", "tree"]);
  return { commit: commit(row["commit"]), tree: commit(row["tree"]) };
}
function date(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(result) || !Number.isFinite(Date.parse(result))) { invalid("growth-authority-time-invalid"); }
  return result;
}
function exact(left: unknown, right: unknown, reason: string): void {
  if (growthCanonicalJson(left) !== growthCanonicalJson(right)) { invalid(reason); }
}
function integrity(value: unknown): string {
  const result = text(value);
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(result)) { invalid("growth-authority-integrity-invalid"); }
  return result;
}
function exactVersion(value: unknown): string {
  return text(value);
}
function repositoryPath(value: unknown): string {
  const result = text(value), segments = result.split("/");
  if (result.startsWith("/") || result.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    invalid("growth-authority-path-invalid");
  }
  return result;
}

export function growthAuthorityRepositoryIdentity(repository: GrowthAuthorityRepository): string {
  return `${repository.provider}:${repository.repositoryId}`;
}
function validateRepository(value: unknown): GrowthAuthorityRepository {
  const row = object(value, ["provider", "repositoryId", "owner", "name"]);
  const provider = text(row["provider"]), repositoryId = text(row["repositoryId"]);
  if (!/^[a-z][a-z0-9.-]*$/u.test(provider) || !/^(?:0|[1-9]\d*)$/u.test(repositoryId)) { invalid("growth-authority-repository-invalid"); }
  return { provider, repositoryId, owner: text(row["owner"]), name: text(row["name"]) };
}

export function validateGrowthAuthorityBinding(value: unknown): GrowthAuthorityBinding {
  const row = object(value, ["invocation", "target", "verifier", "tool", "policy", "historyDigest", "evidenceManifestDigest"]);
  const targetRow = object(row["target"], ["repository", "pullRequestNumber", "head", "base", "mergeBase", "evaluation", "evaluationKind"]);
  const repository = validateRepository(targetRow["repository"]), pullRequestNumber = targetRow["pullRequestNumber"];
  if (!Number.isSafeInteger(pullRequestNumber) || (pullRequestNumber as number) <= 0) { invalid("growth-authority-pr-invalid"); }
  if (!["head", "merge-result", "release-preimage"].includes(String(targetRow["evaluationKind"]))) { invalid("growth-authority-evaluation-kind-invalid"); }
  const head = source(targetRow["head"]), base = source(targetRow["base"]), mergeBase = source(targetRow["mergeBase"]), evaluation = source(targetRow["evaluation"]);
  if (targetRow["evaluationKind"] === "head") { exact(evaluation, head, "growth-authority-evaluation-mismatch"); }
  const verifier = object(row["verifier"], ["identity", "immutableRevision", "artifactDigest"]);
  const tool = object(row["tool"], ["packageName", "version", "archiveDigest", "archiveIntegrity", "distributionDigest", "extractorVersion"]);
  if (tool["packageName"] !== "@agent-teams/engineering-foundation") { invalid("growth-authority-tool-invalid"); }
  const policy = object(row["policy"], ["contractRevision", "policyVersion", "enrollmentRevision", "configurationDigest", "scopeDigest", "commandDigest"]);
  if (policy["contractRevision"] !== "foundation:sdk-growth:c0:5" || policy["policyVersion"] !== "foundation:sdk-growth:policy:1") { invalid("growth-authority-policy-invalid"); }
  const invocation = normalizeGrowthInvocation(row["invocation"] as GrowthAuthorityBinding["invocation"]);
  if (invocation.repository !== growthAuthorityRepositoryIdentity(repository)
    || invocation.sourceCommit !== evaluation.commit || invocation.sourceTree !== evaluation.tree) { invalid("growth-authority-evaluation-mismatch"); }
  const version = exactVersion(tool["version"]), extractorVersion = text(tool["extractorVersion"]), distributionDigest = digest(tool["distributionDigest"]);
  if (version !== invocation.tool.version || extractorVersion !== invocation.tool.extractorVersion || distributionDigest !== invocation.tool.artifactDigest) {
    invalid("growth-authority-tool-binding-mismatch");
  }
  return {
    invocation,
    target: { repository, pullRequestNumber: pullRequestNumber as number, head, base, mergeBase, evaluation,
      evaluationKind: targetRow["evaluationKind"] as GrowthAuthorityBinding["target"]["evaluationKind"] },
    verifier: { identity: text(verifier["identity"]), immutableRevision: commit(verifier["immutableRevision"]), artifactDigest: digest(verifier["artifactDigest"]) },
    tool: { packageName: "@agent-teams/engineering-foundation", version, archiveDigest: digest(tool["archiveDigest"]),
      archiveIntegrity: integrity(tool["archiveIntegrity"]), distributionDigest, extractorVersion },
    policy: { contractRevision: "foundation:sdk-growth:c0:5", policyVersion: "foundation:sdk-growth:policy:1",
      enrollmentRevision: commit(policy["enrollmentRevision"]), configurationDigest: digest(policy["configurationDigest"]),
      scopeDigest: digest(policy["scopeDigest"]), commandDigest: digest(policy["commandDigest"]) },
    historyDigest: digest(row["historyDigest"]), evidenceManifestDigest: digest(row["evidenceManifestDigest"])
  };
}

function validateSelectors(value: unknown): GrowthAuthorityRequest["contextSelectors"] {
  const row = object(structuredClone(value), ["trustedBasePath", "decisionsPath", "released"]);
  if (!Array.isArray(row["released"]) || row["released"].length > 10_000) { invalid("growth-authority-selectors-invalid"); }
  const released = row["released"].map((entry) => {
    const wire = object(entry, (entry as { kind?: unknown })?.kind === "released"
      ? ["packageName", "kind", "observationPath"] : ["packageName", "kind", "trustedHistoryPath"]);
    const packageName = text(wire["packageName"]);
    if (wire["kind"] === "released") { return { packageName, kind: "released" as const, observationPath: repositoryPath(wire["observationPath"]) }; }
    if (wire["kind"] === "initial-unreleased") { return { packageName, kind: "initial-unreleased" as const, trustedHistoryPath: repositoryPath(wire["trustedHistoryPath"]) }; }
    return invalid("growth-authority-selectors-invalid");
  });
  return { trustedBasePath: repositoryPath(row["trustedBasePath"]), decisionsPath: repositoryPath(row["decisionsPath"]),
    released: growthUniqueSorted(released, (entry) => entry.packageName) };
}
export function validateGrowthAuthorityRequest(value: unknown): GrowthAuthorityRequest {
  const row = object(value, ["schemaVersion", "kind", "operation", "admissionReceiptId", "binding", "contextSelectors", "decisionDigests", "requiredPhases"]);
  if (row["schemaVersion"] !== growthAuthoritySchemaVersion || row["kind"] !== "request" || !["check", "promote-release"].includes(String(row["operation"]))) {
    invalid("growth-authority-request-invalid");
  }
  if (!Array.isArray(row["decisionDigests"]) || row["decisionDigests"].length > 10_000) { invalid("growth-authority-decision-budget-exhausted"); }
  if ((row["operation"] === "check" && row["admissionReceiptId"] !== null)
    || (row["operation"] === "promote-release" && (typeof row["admissionReceiptId"] !== "string" || row["admissionReceiptId"].trim() === ""))) {
    invalid("growth-authority-admission-receipt-invalid");
  }
  if (!Array.isArray(row["requiredPhases"])) { invalid("growth-authority-phases-invalid"); }
  exact(row["requiredPhases"], growthAuthorityRequiredPhases, "growth-authority-phases-invalid");
  return { schemaVersion: growthAuthoritySchemaVersion, kind: "request", operation: row["operation"] as GrowthAuthorityRequest["operation"],
    admissionReceiptId: row["admissionReceiptId"] as string | null, binding: validateGrowthAuthorityBinding(row["binding"]),
    contextSelectors: validateSelectors(row["contextSelectors"]),
    decisionDigests: growthUniqueSorted(row["decisionDigests"].map(digest), (entry) => entry), requiredPhases: growthAuthorityRequiredPhases };
}

export function growthAuthorityRequestDigest(request: GrowthAuthorityRequest, fingerprint: ChangeFingerprint): GrowthDigest {
  return hashGrowthPayload({ domain: "reviewrouter:sdk-growth-authority:request:1", request: validateGrowthAuthorityRequest(request) }, fingerprint);
}
export function growthAuthorityArtifactEvidence(snapshot: PublicApiSnapshot, fingerprint: ChangeFingerprint): {
  readonly archiveDigest: GrowthDigest;
  readonly archiveIntegrity: string;
} {
  if (fingerprint.sha512Integrity === undefined) { invalid("growth-authority-sha512-unavailable"); }
  const bytes = growthCanonicalJson({ domain: "reviewrouter:sdk-growth-authority:artifact-snapshot:1", snapshot });
  return { archiveDigest: `sha256:${fingerprint.sha256(bytes)}`, archiveIntegrity: fingerprint.sha512Integrity(bytes) };
}
export function growthAuthorityGrantDigest(grant: GrowthAuthorityGrant, fingerprint: ChangeFingerprint): GrowthDigest {
  return hashGrowthPayload({ domain: "reviewrouter:sdk-growth-authority:grant:1", grant }, fingerprint);
}
export function growthAuthorityCompletionDigest(completion: GrowthAuthorityCompletion, fingerprint: ChangeFingerprint): GrowthDigest {
  return hashGrowthPayload({ domain: "reviewrouter:sdk-growth-authority:completion:1", completion }, fingerprint);
}
export function growthPromotionPlanDigest(plan: GrowthPromotionPlan, fingerprint: ChangeFingerprint): GrowthDigest {
  return hashGrowthPayload({ domain: "reviewrouter:sdk-growth-authority:promotion-plan:1", plan }, fingerprint);
}
export function growthReportAuthorityDigests(report: GrowthReport, fingerprint: ChangeFingerprint): { coverageDigest: GrowthDigest; phasesDigest: GrowthDigest } {
  return { coverageDigest: hashGrowthPayload({ domain: "reviewrouter:sdk-growth-authority:coverage:1", coverage: report.coverage }, fingerprint),
    phasesDigest: hashGrowthPayload({ domain: "reviewrouter:sdk-growth-authority:phases:1", phases: report.phases }, fingerprint) };
}

function validateOwnerEvidence(value: unknown): GrowthAuthorityOwnerEvidence {
  const row = object(value, ["decisionId", "ownerRef", "decisionDigest", "authenticatedSubjectId", "authorizationEvidenceDigest", "approvalEvidenceDigest", "sourceBindingDigest"]);
  return { decisionId: text(row["decisionId"]), ownerRef: text(row["ownerRef"]), decisionDigest: digest(row["decisionDigest"]),
    authenticatedSubjectId: text(row["authenticatedSubjectId"]), authorizationEvidenceDigest: digest(row["authorizationEvidenceDigest"]),
    approvalEvidenceDigest: digest(row["approvalEvidenceDigest"]), sourceBindingDigest: digest(row["sourceBindingDigest"]) };
}
function validateReleaseEvidence(value: unknown, packageName: string): GrowthAuthorityReleasedEvidence["releaseEvidence"] {
  const candidate = value as { declaredBump?: unknown; prereleaseInitialVersion?: unknown; prereleaseTag?: unknown };
  const row = object(value, ["packageName", "packageVersion", ...(candidate.declaredBump === undefined ? [] : ["declaredBump"]),
    ...(candidate.prereleaseInitialVersion === undefined ? [] : ["prereleaseInitialVersion"]), ...(candidate.prereleaseTag === undefined ? [] : ["prereleaseTag"])]);
  if (row["packageName"] !== packageName) { invalid("growth-authority-release-identity-mismatch"); }
  const declaredBump = row["declaredBump"];
  if (declaredBump !== undefined && !["patch", "minor", "major"].includes(String(declaredBump))) { invalid("growth-authority-release-invalid"); }
  const prereleaseInitialVersion = row["prereleaseInitialVersion"], prereleaseTag = row["prereleaseTag"];
  if ((prereleaseInitialVersion === undefined) !== (prereleaseTag === undefined)) { invalid("growth-authority-release-invalid"); }
  return { packageName, packageVersion: exactVersion(row["packageVersion"]),
    ...(declaredBump === undefined ? {} : { declaredBump: declaredBump as "patch" | "minor" | "major" }),
    ...(prereleaseInitialVersion === undefined ? {} : { prereleaseInitialVersion: exactVersion(prereleaseInitialVersion), prereleaseTag: text(prereleaseTag) }) };
}
function validateReleased(value: unknown, repositoryIdentity: string): GrowthAuthorityReleasedEvidence {
  const candidate = value as { observation?: unknown }, row = object(value,
    ["packageName", "releaseEvidence", ...(candidate.observation === undefined ? [] : ["observation"]), "evidence"]);
  const packageName = text(row["packageName"]), releaseEvidence = validateReleaseEvidence(row["releaseEvidence"], packageName);
  const evidence = row["evidence"] as { kind?: unknown };
  const wire = object(evidence, evidence?.kind === "released" ? ["kind", "typed", "artifact"] : ["kind", "historyDigest"]);
  const observationInput = candidate.observation;
  const observation = observationInput === undefined ? undefined : normalizeGrowthObservation(observationInput as NonNullable<GrowthAuthorityReleasedEvidence["observation"]>);
  if (observation !== undefined && observation.repository !== repositoryIdentity) { invalid("growth-authority-release-repository-mismatch"); }
  if (wire["kind"] === "released") {
    const typed = structuredClone(wire["typed"]) as PublicApiSnapshot, artifact = structuredClone(wire["artifact"]) as PublicApiSnapshot;
    return { packageName, releaseEvidence, ...(observation === undefined ? {} : { observation }),
      evidence: { kind: "released", typed, artifact } };
  }
  if (wire["kind"] === "initial-unreleased") {
    return { packageName, releaseEvidence, ...(observation === undefined ? {} : { observation }),
      evidence: { kind: "initial-unreleased", historyDigest: digest(wire["historyDigest"]) } };
  }
  return invalid("growth-authority-release-kind-invalid");
}
function validateArchive(value: unknown, evaluation: GrowthAuthoritySource): GrowthAuthorityGrant["archives"][number] {
  const row = object(value, ["packageName", "packageVersion", "source", "archiveDigest", "archiveIntegrity", "custodyEvidenceDigest"]);
  const archiveSource = source(row["source"]);
  exact(archiveSource, evaluation, "growth-authority-archive-source-mismatch");
  return { packageName: text(row["packageName"]), packageVersion: exactVersion(row["packageVersion"]), source: archiveSource,
    archiveDigest: digest(row["archiveDigest"]), archiveIntegrity: integrity(row["archiveIntegrity"]), custodyEvidenceDigest: digest(row["custodyEvidenceDigest"]) };
}
function validateAdmissionReceipt(value: unknown, request: GrowthAuthorityRequest, binding: GrowthAuthorityBinding): GrowthAuthorityGrant["admissionReceipt"] {
  const candidate = value as { kind?: unknown }, row = object(value, candidate?.kind === "none" ? ["kind"] : ["kind", "receipt"]);
  if (request.operation === "check") {
    if (row["kind"] !== "none") { invalid("growth-authority-admission-receipt-invalid"); }
    return { kind: "none" };
  }
  if (row["kind"] !== "receipt") { invalid("growth-authority-admission-receipt-invalid"); }
  const receiptRow = object(row["receipt"], ["schemaVersion", "kind", "receiptId", "grantId", "grantDigest", "completionDigest", "binding", "reportDigest", "coverageDigest",
    "phasesDigest", "verdict", "releaseEligible", "qualification", "operation", "promotion", "custodyRef", "issuedAt"]);
  if (receiptRow["schemaVersion"] !== growthAuthoritySchemaVersion || receiptRow["kind"] !== "receipt" || receiptRow["receiptId"] !== request.admissionReceiptId
    || receiptRow["operation"] !== "check" || receiptRow["qualification"] !== "qualified" || receiptRow["verdict"] !== "admitted"
    || receiptRow["releaseEligible"] !== true) { invalid("growth-authority-admission-receipt-invalid"); }
  const promotion = object(receiptRow["promotion"], ["kind"]);
  if (promotion["kind"] !== "none") { invalid("growth-authority-admission-receipt-invalid"); }
  const receiptBinding = validateGrowthAuthorityBinding(receiptRow["binding"]);
  exact(receiptBinding, binding, "growth-authority-admission-binding-mismatch");
  return { kind: "receipt", receipt: { schemaVersion: growthAuthoritySchemaVersion, kind: "receipt", receiptId: text(receiptRow["receiptId"]),
    grantId: text(receiptRow["grantId"]), grantDigest: digest(receiptRow["grantDigest"]), completionDigest: digest(receiptRow["completionDigest"]), binding: receiptBinding,
    reportDigest: digest(receiptRow["reportDigest"]), coverageDigest: digest(receiptRow["coverageDigest"]), phasesDigest: digest(receiptRow["phasesDigest"]),
    verdict: "admitted", releaseEligible: true, qualification: "qualified", operation: "check", promotion: { kind: "none" },
    custodyRef: text(receiptRow["custodyRef"]), issuedAt: date(receiptRow["issuedAt"]) } };
}

function validateGrantEnvelope(row: Record<string, unknown>, now: Date): { issuedAt: string; expiresAt: string } {
  const issuedAt = date(row["issuedAt"]), expiresAt = date(row["expiresAt"]);
  if (Date.parse(issuedAt) > now.getTime() || Date.parse(expiresAt) <= now.getTime() || Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    invalid("growth-authority-grant-expired");
  }
  const collections = [row["released"], row["ownerEvidence"], row["archives"]];
  if (collections.some((entry) => !Array.isArray(entry) || entry.length > 10_000)) { invalid("growth-authority-grant-invalid"); }
  if (!Array.isArray(row["requiredPhases"])) { invalid("growth-authority-phases-invalid"); }
  exact(row["requiredPhases"], growthAuthorityRequiredPhases, "growth-authority-phases-invalid");
  return { issuedAt, expiresAt };
}

/** Validates protocol framing and exact request bindings. Content schemas are
 * validated by the verified context adapter before application policy sees it. */
export function validateGrowthAuthorityGrant(value: unknown, request: GrowthAuthorityRequest, fingerprint: ChangeFingerprint, now = new Date()): GrowthAuthorityGrant {
  const row = object(value, ["schemaVersion", "kind", "grantId", "requestDigest", "admissionReceipt", "binding", "workflowRef", "runRef", "issuedAt", "expiresAt",
    "trustedBase", "trustedBaseReference", "retainedHistory", "released", "ownerEvidence", "archives", "requiredCoverageDigest", "requiredPhases"]);
  if (row["schemaVersion"] !== growthAuthoritySchemaVersion || row["kind"] !== "grant") { invalid("growth-authority-grant-invalid"); }
  const binding = validateGrowthAuthorityBinding(row["binding"]);
  exact(binding, request.binding, "growth-authority-binding-mismatch");
  const requestDigest = digest(row["requestDigest"]);
  if (requestDigest !== growthAuthorityRequestDigest(request, fingerprint)) { invalid("growth-authority-request-mismatch"); }
  const { issuedAt, expiresAt } = validateGrantEnvelope(row, now);
  const trustedBase = normalizeGrowthObservation(row["trustedBase"] as GrowthAuthorityGrant["trustedBase"]);
  if (trustedBase.repository !== binding.invocation.repository) { invalid("growth-authority-base-repository-mismatch"); }
  const referenceRow = object(row["trustedBaseReference"], ["sourceCommit", "sourceTree", "surfaceDigest", "topologyDigest", "lockDigest", "toolchainDigest", "artifactDigests"]);
  if (!Array.isArray(referenceRow["artifactDigests"])) { invalid("growth-authority-base-reference-invalid"); }
  const trustedBaseReference = { sourceCommit: commit(referenceRow["sourceCommit"]), sourceTree: commit(referenceRow["sourceTree"]),
    surfaceDigest: digest(referenceRow["surfaceDigest"]), topologyDigest: digest(referenceRow["topologyDigest"]), lockDigest: digest(referenceRow["lockDigest"]),
    toolchainDigest: digest(referenceRow["toolchainDigest"]), artifactDigests: growthUniqueSorted(referenceRow["artifactDigests"].map(digest), (entry) => entry) };
  exact(trustedBaseReference, growthObservationReference(trustedBase, fingerprint), "growth-authority-base-reference-mismatch");
  const history = object(row["retainedHistory"], ["targetSource", "targetSurfaceDigest", "receiptDigest", "custodyEvidenceDigest"]);
  const targetSource = source(history["targetSource"]);
  exact(targetSource, { commit: trustedBase.sourceCommit, tree: trustedBase.sourceTree }, "growth-authority-history-source-mismatch");
  if (digest(history["targetSurfaceDigest"]) !== trustedBaseReference.surfaceDigest) { invalid("growth-authority-history-target-mismatch"); }
  const releasedInput = row["released"] as unknown[], ownerInput = row["ownerEvidence"] as unknown[], archiveInput = row["archives"] as unknown[];
  const released = growthUniqueSorted(releasedInput.map((entry) => validateReleased(entry, binding.invocation.repository)), (entry) => entry.packageName);
  const ownerEvidence = growthUniqueSorted(ownerInput.map(validateOwnerEvidence), (entry) => entry.decisionId);
  const archives = growthUniqueSorted(archiveInput.map((entry) => validateArchive(entry, binding.target.evaluation)), (entry) => entry.packageName);
  exact(released.map((entry) => ({ packageName: entry.packageName, kind: entry.evidence.kind })),
    request.contextSelectors.released.map((entry) => ({ packageName: entry.packageName, kind: entry.kind })),
  "growth-authority-release-selector-mismatch");
  for (const owner of ownerEvidence) {
    if (owner.sourceBindingDigest !== requestDigest || !request.decisionDigests.includes(owner.decisionDigest)) {
      invalid("growth-authority-owner-source-mismatch");
    }
  }
  exact(archives.map((entry) => entry.packageName), released.map((entry) => entry.packageName), "growth-authority-archive-scope-mismatch");
  for (const releasedRow of released) {
    const archive = archives.find((entry) => entry.packageName === releasedRow.packageName)!;
    if (archive.packageVersion !== releasedRow.releaseEvidence.packageVersion) { invalid("growth-authority-archive-version-mismatch"); }
    if (releasedRow.evidence.kind !== "released") { continue; }
    const expected = growthAuthorityArtifactEvidence(releasedRow.evidence.artifact, fingerprint);
    if (archive.archiveDigest !== expected.archiveDigest || archive.archiveIntegrity !== expected.archiveIntegrity) {
      invalid("growth-authority-archive-artifact-mismatch");
    }
  }
  return { schemaVersion: growthAuthoritySchemaVersion, kind: "grant", grantId: text(row["grantId"]), requestDigest,
    admissionReceipt: validateAdmissionReceipt(row["admissionReceipt"], request, binding), binding,
    workflowRef: text(row["workflowRef"]), runRef: text(row["runRef"]), issuedAt, expiresAt, trustedBase, trustedBaseReference,
    retainedHistory: { targetSource, targetSurfaceDigest: digest(history["targetSurfaceDigest"]), receiptDigest: digest(history["receiptDigest"]),
      custodyEvidenceDigest: digest(history["custodyEvidenceDigest"]) }, released, ownerEvidence, archives,
    requiredCoverageDigest: digest(row["requiredCoverageDigest"]), requiredPhases: growthAuthorityRequiredPhases };
}

function validatePromotion(value: unknown): GrowthAuthorityReceipt["promotion"] {
  const candidate = value as { kind?: unknown }, row = object(value, candidate?.kind === "none" ? ["kind"] : ["kind", "planDigest"]);
  if (row["kind"] === "none") { return { kind: "none" }; }
  if (row["kind"] === "plan") { return { kind: "plan", planDigest: digest(row["planDigest"]) }; }
  return invalid("growth-authority-promotion-invalid");
}
export function validateGrowthAuthorityReceipt(value: unknown, completion: GrowthAuthorityCompletion, operation: GrowthAuthorityRequest["operation"], fingerprint: ChangeFingerprint): GrowthAuthorityReceipt {
  const row = object(value, ["schemaVersion", "kind", "receiptId", "grantId", "grantDigest", "completionDigest", "binding", "reportDigest",
    "coverageDigest", "phasesDigest", "verdict", "releaseEligible", "qualification", "operation", "promotion", "custodyRef", "issuedAt"]);
  if (row["schemaVersion"] !== growthAuthoritySchemaVersion || row["kind"] !== "receipt" || row["operation"] !== operation) { invalid("growth-authority-receipt-invalid"); }
  const binding = validateGrowthAuthorityBinding(row["binding"]), promotion = validatePromotion(row["promotion"]);
  exact(binding, completion.binding, "growth-authority-receipt-binding-mismatch");
  if ((operation === "check") !== (promotion.kind === "none")) { invalid("growth-authority-promotion-invalid"); }
  const receipt = { schemaVersion: growthAuthoritySchemaVersion, kind: "receipt" as const, receiptId: text(row["receiptId"]),
    grantId: text(row["grantId"]), grantDigest: digest(row["grantDigest"]), completionDigest: digest(row["completionDigest"]), binding,
    reportDigest: digest(row["reportDigest"]), coverageDigest: digest(row["coverageDigest"]), phasesDigest: digest(row["phasesDigest"]),
    verdict: row["verdict"], releaseEligible: row["releaseEligible"], qualification: row["qualification"], operation, promotion,
    custodyRef: text(row["custodyRef"]), issuedAt: date(row["issuedAt"]) } as GrowthAuthorityReceipt;
  if (!["admitted", "rejected", "incomplete"].includes(String(receipt.verdict)) || typeof receipt.releaseEligible !== "boolean"
    || !["qualified", "not-qualified"].includes(String(receipt.qualification))) { invalid("growth-authority-receipt-invalid"); }
  exact({ grantId: receipt.grantId, grantDigest: receipt.grantDigest, binding: receipt.binding, reportDigest: receipt.reportDigest,
    coverageDigest: receipt.coverageDigest, phasesDigest: receipt.phasesDigest, verdict: receipt.verdict, releaseEligible: receipt.releaseEligible,
    promotion: receipt.promotion }, { grantId: completion.grantId, grantDigest: completion.grantDigest, binding: completion.binding,
    reportDigest: completion.reportDigest, coverageDigest: completion.coverageDigest, phasesDigest: completion.phasesDigest,
    verdict: completion.verdict, releaseEligible: completion.releaseEligible, promotion: completion.promotion }, "growth-authority-receipt-mismatch");
  if (receipt.completionDigest !== growthAuthorityCompletionDigest(completion, fingerprint)) { invalid("growth-authority-completion-mismatch"); }
  if ((receipt.qualification === "qualified") !== (receipt.verdict === "admitted" && receipt.releaseEligible)) { invalid("growth-authority-qualification-mismatch"); }
  return receipt;
}
