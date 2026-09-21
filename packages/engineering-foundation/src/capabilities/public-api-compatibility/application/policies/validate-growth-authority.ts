import type {
  GrowthAuthorityBinding, GrowthAuthorityCompletion, GrowthAuthorityGrant,
  GrowthAuthorityOwnerEvidence, GrowthAuthorityPackedEvidence, GrowthAuthorityReceipt, GrowthAuthorityReleasedEvidence,
  GrowthAuthorityRepository, GrowthAuthorityRequest, GrowthPromotionPlan
} from "../model/growth-authority.js";
import { growthAuthorityRequiredPhases, growthAuthoritySchemaVersion } from "../model/growth-authority.js";
import type { GrowthDigest } from "../model/growth-observation.js";
import type { GrowthReport } from "../model/growth-report.js";
import type { PublicApiSnapshot } from "../model/public-api.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import { hashGrowthPayload } from "./compare-growth-surfaces.js";
import { validateGrowthMetadataRoots } from "./validate-growth-metadata-root.js";
export { growthDecisionDigest, prepareGrowthDecisions } from "./evaluate-growth-admission.js";
import { growthCanonicalJson, growthObservationReference, growthUniqueSorted, normalizeGrowthInvocation, normalizeGrowthObservation } from "./normalize-growth-observation.js";
import { array, commit, custodyPath, date, digest, exact, exactVersion, integrity, invalid, member, object, repositoryPath, source, text, uniqueMap } from "./validate-growth-authority-primitives.js";
export { validateGrowthInstalledInventory } from "./validate-growth-installed-inventory.js";

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
    const kind = member(entry, "kind");
    if (kind !== "released" && kind !== "initial-unreleased") { return invalid("growth-authority-selectors-invalid"); }
    const wire = object(entry, kind === "released"
      ? ["packageName", "kind", "observationPath"] : ["packageName", "kind", "trustedHistoryPath"]);
    const packageName = text(wire["packageName"]);
    return kind === "released"
      ? { packageName, kind: "released" as const, observationPath: repositoryPath(wire["observationPath"]) }
      : { packageName, kind: "initial-unreleased" as const, trustedHistoryPath: repositoryPath(wire["trustedHistoryPath"]) };
  });
  uniqueMap(released, (entry) => entry.packageName, "growth-authority-selector-duplicate");
  return { trustedBasePath: repositoryPath(row["trustedBasePath"]), decisionsPath: repositoryPath(row["decisionsPath"]),
    released: growthUniqueSorted(released, (entry) => entry.packageName) };
}
function validateGrowthAuthorityRequest(value: unknown): GrowthAuthorityRequest {
  const row = object(value, ["schemaVersion", "kind", "operation", "admissionReceiptId", "binding", "contextSelectors", "decisionDigests", "requiredPhases"]);
  if (row["schemaVersion"] !== growthAuthoritySchemaVersion || row["kind"] !== "request" || !["check", "promote-release"].includes(String(row["operation"]))) {
    invalid("growth-authority-request-invalid");
  }
  if (!Array.isArray(row["decisionDigests"]) || row["decisionDigests"].length > 10_000) { invalid("growth-authority-decision-budget-exhausted"); }
  const decisionDigests = row["decisionDigests"].map(digest);
  if (new Set(decisionDigests).size !== decisionDigests.length) { invalid("growth-authority-decision-duplicate"); }
  if ((row["operation"] === "check" && row["admissionReceiptId"] !== null)
    || (row["operation"] === "promote-release" && (typeof row["admissionReceiptId"] !== "string" || row["admissionReceiptId"].trim() === ""))) {
    invalid("growth-authority-admission-receipt-invalid");
  }
  if (!Array.isArray(row["requiredPhases"])) { invalid("growth-authority-phases-invalid"); }
  exact(row["requiredPhases"], growthAuthorityRequiredPhases, "growth-authority-phases-invalid");
  return { schemaVersion: growthAuthoritySchemaVersion, kind: "request", operation: row["operation"] as GrowthAuthorityRequest["operation"],
    admissionReceiptId: row["admissionReceiptId"] as string | null, binding: validateGrowthAuthorityBinding(row["binding"]),
    contextSelectors: validateSelectors(row["contextSelectors"]),
    decisionDigests: growthUniqueSorted(decisionDigests, (entry) => entry), requiredPhases: growthAuthorityRequiredPhases };
}

export function growthAuthorityRequestDigest(request: GrowthAuthorityRequest, fingerprint: ChangeFingerprint): GrowthDigest {
  return hashGrowthPayload({ domain: "reviewrouter:sdk-growth-authority:request:3", request: validateGrowthAuthorityRequest(request) }, fingerprint);
}
export function growthAuthorityGrantDigest(grant: GrowthAuthorityGrant, fingerprint: ChangeFingerprint): GrowthDigest {
  return hashGrowthPayload({ domain: "reviewrouter:sdk-growth-authority:grant:3", grant }, fingerprint);
}
export function growthAuthorityCompletionDigest(completion: GrowthAuthorityCompletion, fingerprint: ChangeFingerprint): GrowthDigest {
  return hashGrowthPayload({ domain: "reviewrouter:sdk-growth-authority:completion:3", completion }, fingerprint);
}
export function growthPromotionPlanDigest(plan: GrowthPromotionPlan, fingerprint: ChangeFingerprint): GrowthDigest {
  return hashGrowthPayload({ domain: "reviewrouter:sdk-growth-authority:promotion-plan:3", plan }, fingerprint);
}
export function growthReportAuthorityDigests(report: GrowthReport, fingerprint: ChangeFingerprint): { coverageDigest: GrowthDigest; phasesDigest: GrowthDigest } {
  return { coverageDigest: hashGrowthPayload({ domain: "reviewrouter:sdk-growth-authority:coverage:3", coverage: report.coverage }, fingerprint),
    phasesDigest: hashGrowthPayload({ domain: "reviewrouter:sdk-growth-authority:phases:3", phases: report.phases }, fingerprint) };
}

function validateOwnerEvidence(value: unknown): GrowthAuthorityOwnerEvidence {
  const row = object(value, ["decisionId", "ownerRef", "decisionDigest", "authenticatedSubjectId", "authorizationEvidenceDigest", "approvalEvidenceDigest", "sourceBindingDigest"]);
  return { decisionId: text(row["decisionId"]), ownerRef: text(row["ownerRef"]), decisionDigest: digest(row["decisionDigest"]),
    authenticatedSubjectId: text(row["authenticatedSubjectId"]), authorizationEvidenceDigest: digest(row["authorizationEvidenceDigest"]),
    approvalEvidenceDigest: digest(row["approvalEvidenceDigest"]), sourceBindingDigest: digest(row["sourceBindingDigest"]) };
}
function validateReleaseEvidence(value: unknown, packageName: string): GrowthAuthorityReleasedEvidence["releaseEvidence"] {
  const declaredBumpInput = member(value, "declaredBump");
  const prereleaseInitialVersionInput = member(value, "prereleaseInitialVersion");
  const prereleaseTagInput = member(value, "prereleaseTag");
  const row = object(value, ["packageName", "packageVersion", ...(declaredBumpInput === undefined ? [] : ["declaredBump"]),
    ...(prereleaseInitialVersionInput === undefined ? [] : ["prereleaseInitialVersion"]), ...(prereleaseTagInput === undefined ? [] : ["prereleaseTag"])]);
  if (row["packageName"] !== packageName) { invalid("growth-authority-release-identity-mismatch"); }
  const declaredBump = row["declaredBump"];
  if (declaredBump !== undefined && declaredBump !== "patch" && declaredBump !== "minor" && declaredBump !== "major") {
    invalid("growth-authority-release-invalid");
  }
  const prereleaseInitialVersion = row["prereleaseInitialVersion"], prereleaseTag = row["prereleaseTag"];
  if ((prereleaseInitialVersion === undefined) !== (prereleaseTag === undefined)) { invalid("growth-authority-release-invalid"); }
  return { packageName, packageVersion: exactVersion(row["packageVersion"]),
    ...(declaredBump === undefined ? {} : { declaredBump }),
    ...(prereleaseInitialVersion === undefined ? {} : { prereleaseInitialVersion: exactVersion(prereleaseInitialVersion), prereleaseTag: text(prereleaseTag) }) };
}
type ProxyInspection = Readonly<{ isProxy(value: unknown): boolean }>;

function rejectSnapshotProxy(value: unknown, inspection: ProxyInspection, reason: string): void {
  try {
    if (inspection.isProxy(value)) { invalid(reason); }
  } catch {
    invalid(reason);
  }
}
function snapshotObject(value: unknown, keys: readonly string[], inspection: ProxyInspection, reason: string): Record<string, unknown> {
  rejectSnapshotProxy(value, inspection, reason);
  return object(value, keys, reason);
}
function snapshotArray(value: unknown, limit: number, inspection: ProxyInspection, reason: string): readonly unknown[] {
  rejectSnapshotProxy(value, inspection, reason);
  return array(value, limit, reason);
}
function snapshotSignature(value: unknown, reason: string): string {
  if (typeof value !== "string") { invalid(reason); }
  let length = 0;
  for (const codePoint of value) {
    if (codePoint !== "") { length += 1; }
    if (length > 10_000) { invalid(reason); }
  }
  return value;
}
function validatePublicApiSnapshot(value: unknown, inspection: ProxyInspection): PublicApiSnapshot {
  const reason = "growth-authority-release-snapshot-invalid";
  const row = snapshotObject(value, ["schemaVersion", "packageName", "packageVersion", "extractorVersion", "entrypoints"], inspection, reason);
  if (row["schemaVersion"] !== 1) { invalid(reason); }
  const packageName = text(row["packageName"]);
  const entrypoints = snapshotArray(row["entrypoints"], 10_000, inspection, reason).map((entrypointInput) => {
    const entrypoint = snapshotObject(entrypointInput, ["exportPath", "items"], inspection, reason);
    const items = snapshotArray(entrypoint["items"], 100_000, inspection, reason).map((itemInput) => {
      rejectSnapshotProxy(itemInput, inspection, reason);
      const parentReference = member(itemInput, "parentReference");
      const item = snapshotObject(itemInput, ["canonicalReference", "kind",
        ...(parentReference === undefined ? [] : ["parentReference"]), "parentKind", "signature"], inspection, reason);
      return { canonicalReference: text(item["canonicalReference"]), kind: text(item["kind"]),
        ...(parentReference === undefined ? {} : { parentReference: text(parentReference) }),
        parentKind: text(item["parentKind"]), signature: snapshotSignature(item["signature"], reason) };
    });
    return { exportPath: text(entrypoint["exportPath"]), items };
  });
  return { schemaVersion: 1, packageName, packageVersion: exactVersion(row["packageVersion"]),
    extractorVersion: text(row["extractorVersion"]), entrypoints };
}
function validateReleased(value: unknown, repositoryIdentity: string, inspection: ProxyInspection): GrowthAuthorityReleasedEvidence {
  const observationInput = member(value, "observation");
  const row = object(value,
    ["packageName", "releaseEvidence", ...(observationInput === undefined ? [] : ["observation"]), "evidence"]);
  const packageName = text(row["packageName"]), releaseEvidence = validateReleaseEvidence(row["releaseEvidence"], packageName);
  const evidence = row["evidence"], kind = member(evidence, "kind");
  if (kind !== "released" && kind !== "initial-unreleased") { return invalid("growth-authority-release-kind-invalid"); }
  const wire = object(evidence, kind === "released" ? ["kind", "typed", "artifact"] : ["kind", "historyDigest"],
    kind === "released" ? "growth-authority-release-snapshot-invalid" : "growth-authority-contract-invalid");
  const observation = observationInput === undefined ? undefined : normalizeGrowthObservation(observationInput as NonNullable<GrowthAuthorityReleasedEvidence["observation"]>);
  if (observation !== undefined && observation.repository !== repositoryIdentity) { invalid("growth-authority-release-repository-mismatch"); }
  if (wire["kind"] === "released") {
    const typed = validatePublicApiSnapshot(wire["typed"], inspection);
    const artifact = validatePublicApiSnapshot(wire["artifact"], inspection);
    return { packageName, releaseEvidence, ...(observation === undefined ? {} : { observation }),
      evidence: { kind: "released", typed, artifact } };
  }
  if (wire["kind"] === "initial-unreleased") {
    return { packageName, releaseEvidence, ...(observation === undefined ? {} : { observation }),
      evidence: { kind: "initial-unreleased", historyDigest: digest(wire["historyDigest"]) } };
  }
  return invalid("growth-authority-release-kind-invalid");
}
function custodyDigest(evidence: GrowthAuthorityPackedEvidence["custodyEvidence"], fingerprint: ChangeFingerprint): GrowthDigest {
  return hashGrowthPayload({ domain: "foundation:sdk-growth:custody:1", payload: evidence }, fingerprint);
}

/** One archive representation: canonical JSON containing sorted paths and lowercase
 * hexadecimal file bytes. Transport compression is deliberately outside this identity. */
function validateCustodyEvidence(value: unknown, fingerprint: ChangeFingerprint): GrowthAuthorityPackedEvidence["custodyEvidence"] {
  const row = object(value, ["archiveDigest", "archiveIntegrity", "archivePayload", "archiveManifest", "installedFiles"]);
  const payload = row["archivePayload"];
  if (typeof payload !== "string" || payload.length > 64 * 1024 * 1024) { invalid("growth-authority-custody-payload-invalid"); }
  let parsed: unknown;
  try { parsed = JSON.parse(payload) as unknown; } catch { invalid("growth-authority-custody-payload-invalid"); }
  const archive = object(parsed, ["schemaVersion", "files"]);
  if (archive["schemaVersion"] !== "foundation:sdk-growth:archive:1") { invalid("growth-authority-custody-payload-invalid"); }
  const paths = new Set<string>();
  const files = array(archive["files"], 100_000, "growth-authority-custody-invalid").map((fileValue) => {
    const file = object(fileValue, ["path", "contentHex"]), name = custodyPath(file["path"]), contentHex = file["contentHex"];
    if (typeof contentHex !== "string" || !/^(?:[a-f0-9]{2})*$/u.test(contentHex)) { invalid("growth-authority-custody-payload-invalid"); }
    const identity = name.toLowerCase();
    if (paths.has(identity)) { invalid("growth-authority-custody-duplicate-path"); }
    paths.add(identity);
    return { path: name, contentHex };
  }).toSorted((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  // Equality and hierarchy both use the same case-folded path identities.
  for (const identity of paths) {
    const parts = identity.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (paths.has(parts.slice(0, index).join("/"))) { invalid("growth-authority-path-invalid"); }
    }
  }
  if (payload !== growthCanonicalJson({ schemaVersion: "foundation:sdk-growth:archive:1", files })) {
    invalid("growth-authority-custody-payload-invalid");
  }
  const archiveDigest = `sha256:${fingerprint.sha256(payload)}`;
  if (fingerprint.sha512Integrity === undefined) { invalid("growth-authority-custody-integrity-unavailable"); }
  const archiveIntegrity = fingerprint.sha512Integrity(payload);
  if (archiveDigest !== digest(row["archiveDigest"])) { invalid("growth-authority-archive-digest-mismatch"); }
  if (archiveIntegrity !== integrity(row["archiveIntegrity"])) { invalid("growth-authority-archive-integrity-mismatch"); }
  const archiveManifest: GrowthAuthorityPackedEvidence["custodyEvidence"]["archiveManifest"] = files.map((file) => ({ path: file.path,
    digest: `sha256:${fingerprint.sha256(Uint8Array.from(file.contentHex.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16)))}` }));
  for (const field of ["archiveManifest", "installedFiles"]) {
    const inventory = array(row[field], 100_000, "growth-authority-custody-invalid").map((fileValue) => {
      const file = object(fileValue, ["path", "digest"]);
      return { path: custodyPath(file["path"]), digest: digest(file["digest"]) };
    });
    uniqueMap(inventory, (file) => file.path.toLowerCase(), "growth-authority-custody-duplicate-path");
    exact(inventory, archiveManifest, "growth-authority-custody-manifest-mismatch");
  }
  return { archiveDigest, archiveIntegrity, archivePayload: payload, archiveManifest, installedFiles: archiveManifest };
}

/** Package coordinates are read from the canonical archive, never inferred from
 * transport labels or a producer's manifest. Retained observations are not packages. */
function validateArchivePackage(custody: GrowthAuthorityPackedEvidence["custodyEvidence"], packageName: string, packageVersion: string): void {
  const archive = JSON.parse(custody.archivePayload) as { files: { path: string; contentHex: string }[] };
  const manifest = archive.files.find((file) => file.path === "package.json");
  if (manifest === undefined) { invalid("growth-authority-archive-package-missing"); }
  let metadata: unknown;
  try {
    const bytes = Uint8Array.from(manifest.contentHex.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
    metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch { invalid("growth-authority-archive-package-invalid"); }
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)
    || member(metadata, "name") !== packageName || member(metadata, "version") !== packageVersion) {
    invalid("growth-authority-archive-package-mismatch");
  }
}

function validatePackedEvidence(value: unknown, repositoryIdentity: string, fingerprint: ChangeFingerprint): GrowthAuthorityPackedEvidence {
  const row = object(value, ["packageName", "packageVersion", "source", "archiveDigest", "archiveIntegrity", "observation",
    "observationDigest", "coverage", "custodyEvidence", "custodyEvidenceDigest", "installedDistribution"]);
  const packageName = text(row["packageName"]), packageVersion = exactVersion(row["packageVersion"]);
  const archiveSource = source(row["source"]), archiveDigest = digest(row["archiveDigest"]);
  const archiveIntegrity = integrity(row["archiveIntegrity"]);
  const observation = normalizeGrowthObservation(row["observation"] as GrowthAuthorityPackedEvidence["observation"]);
  if (observation.repository !== repositoryIdentity) { invalid("growth-authority-packed-repository-mismatch"); }
  exact(archiveSource, { commit: observation.sourceCommit, tree: observation.sourceTree }, "growth-authority-archive-source-mismatch");
  if (observation.coverage.length !== 1 || observation.coverage[0]?.packageName !== packageName
    || observation.entries.some((entry) => entry.coordinate.packageName !== packageName)) {
    invalid("growth-authority-packed-scope-mismatch");
  }
  const observationDigest = digest(row["observationDigest"]);
  if (observationDigest !== growthObservationReference(observation, fingerprint).surfaceDigest) {
    invalid("growth-authority-packed-observation-mismatch");
  }
  exact(row["coverage"], observation.coverage[0], "growth-authority-packed-coverage-mismatch");
  const installed = object(row["installedDistribution"], ["packageName", "packageVersion", "source", "archiveDigest", "archiveIntegrity", "observationDigest"]);
  const installedDistribution = { packageName: text(installed["packageName"]), packageVersion: exactVersion(installed["packageVersion"]),
    source: source(installed["source"]), archiveDigest: digest(installed["archiveDigest"]), archiveIntegrity: integrity(installed["archiveIntegrity"]),
    observationDigest: digest(installed["observationDigest"]) };
  exact(installedDistribution, { packageName, packageVersion, source: archiveSource, archiveDigest, archiveIntegrity, observationDigest },
    "growth-authority-installed-distribution-mismatch");
  const custodyEvidence = validateCustodyEvidence(row["custodyEvidence"], fingerprint);
  validateArchivePackage(custodyEvidence, packageName, packageVersion);
  exact({ archiveDigest, archiveIntegrity }, { archiveDigest: custodyEvidence.archiveDigest, archiveIntegrity: custodyEvidence.archiveIntegrity },
    "growth-authority-custody-inventory-mismatch");
  const custodyEvidenceDigest = custodyDigest(custodyEvidence, fingerprint);
  if (custodyEvidenceDigest !== digest(row["custodyEvidenceDigest"])) { invalid("growth-authority-custody-digest-mismatch"); }
  return { packageName, packageVersion, source: archiveSource, archiveDigest, archiveIntegrity, observation,
    observationDigest, coverage: observation.coverage[0], custodyEvidenceDigest, custodyEvidence, installedDistribution };
}
function validateAdmissionReceipt(value: unknown, request: GrowthAuthorityRequest, binding: GrowthAuthorityBinding,
  fingerprint: ChangeFingerprint, timing: { readonly inspection?: ProxyInspection; readonly now: Date }): GrowthAuthorityGrant["admissionReceipt"] {
  const kind = member(value, "kind");
  const row = object(value, kind === "none" ? ["kind"] : ["kind", "receipt"]);
  if (request.operation === "check") {
    if (row["kind"] !== "none") { invalid("growth-authority-admission-receipt-invalid"); }
    return { kind: "none" };
  }
  if (row["kind"] !== "receipt") { invalid("growth-authority-admission-receipt-invalid"); }
  const receiptValue = row["receipt"];
  const receiptKeys = ["schemaVersion", "kind", "receiptId", "grantId", "grantDigest", "requestDigest", "completionDigest", "provenance",
    "binding", "reportDigest", "coverageDigest", "phasesDigest", "verdict", "releaseEligible", "qualification", "operation", "promotion", "custodyRef", "issuedAt"];
  const receiptRow = object(receiptValue, receiptKeys);
  if (receiptRow["schemaVersion"] !== growthAuthoritySchemaVersion || receiptRow["kind"] !== "receipt" || receiptRow["receiptId"] !== request.admissionReceiptId
    || receiptRow["operation"] !== "check" || receiptRow["qualification"] !== "qualified" || receiptRow["verdict"] !== "admitted"
    || receiptRow["releaseEligible"] !== true) { invalid("growth-authority-admission-receipt-invalid"); }
  const promotion = object(receiptRow["promotion"], ["kind"]);
  if (promotion["kind"] !== "none") { invalid("growth-authority-admission-receipt-invalid"); }
  const receiptBinding = validateGrowthAuthorityBinding(receiptRow["binding"]);
  exact(receiptBinding, binding, "growth-authority-admission-binding-mismatch");
  const checkRequest: GrowthAuthorityRequest = { ...request, operation: "check", admissionReceiptId: null };
  const requestDigest = digest(receiptRow["requestDigest"]);
  if (requestDigest !== growthAuthorityRequestDigest(checkRequest, fingerprint)) {
    invalid("growth-authority-admission-request-mismatch");
  }
  const result = { schemaVersion: growthAuthoritySchemaVersion, kind: "receipt" as const, receiptId: text(receiptRow["receiptId"]),
    grantId: text(receiptRow["grantId"]), grantDigest: digest(receiptRow["grantDigest"]), requestDigest,
    completionDigest: digest(receiptRow["completionDigest"]), binding: receiptBinding,
    reportDigest: digest(receiptRow["reportDigest"]), coverageDigest: digest(receiptRow["coverageDigest"]), phasesDigest: digest(receiptRow["phasesDigest"]),
    verdict: "admitted" as const, releaseEligible: true, qualification: "qualified" as const, operation: "check" as const, promotion: { kind: "none" as const },
    custodyRef: text(receiptRow["custodyRef"]), issuedAt: date(receiptRow["issuedAt"]) };
  if (receiptKeys.includes("provenance")) {
    return validateAdmissionProvenance(result, receiptRow, checkRequest, fingerprint, timing);
  }
  return { kind: "receipt", receipt: result };
}

function validateAdmissionProvenance(result: GrowthAuthorityReceipt, receiptRow: Record<string, unknown>, checkRequest: GrowthAuthorityRequest, fingerprint: ChangeFingerprint, timing: { readonly inspection?: ProxyInspection; readonly now: Date }): GrowthAuthorityGrant["admissionReceipt"] {
  if (timing.inspection === undefined) { invalid("growth-authority-admission-provenance-invalid"); }
  const provenance = object(receiptRow["provenance"], ["grant", "completion"]);
  if (Date.parse(result.issuedAt) > timing.now.getTime()) { invalid("growth-authority-admission-provenance-invalid"); }
  const checkGrant = validateGrowthAuthorityGrant(provenance["grant"], checkRequest, fingerprint, timing.inspection, new Date(result.issuedAt));
  const completionRow = object(provenance["completion"], ["schemaVersion", "kind", "grantId", "grantDigest", "requestDigest", "binding",
    "reportDigest", "reportByteLength", "coverageDigest", "phasesDigest", "verdict", "releaseEligible", "publication", "promotion"]);
  if (completionRow["schemaVersion"] !== growthAuthoritySchemaVersion || completionRow["kind"] !== "completion"
    || completionRow["publication"] !== "finalized" || !Number.isSafeInteger(completionRow["reportByteLength"])
    || (completionRow["reportByteLength"] as number) <= 0) { invalid("growth-authority-admission-provenance-invalid"); }
  const completion = provenance["completion"] as GrowthAuthorityCompletion;
  if (growthAuthorityGrantDigest(checkGrant, fingerprint) !== result.grantDigest
    || checkGrant.grantId !== result.grantId
    || growthAuthorityCompletionDigest(completion, fingerprint) !== result.completionDigest
    || completion.grantId !== result.grantId || completion.grantDigest !== result.grantDigest) {
    invalid("growth-authority-admission-provenance-mismatch");
  }
  validateGrowthAuthorityReceipt(result, completion, "check", fingerprint);
  if (completion.coverageDigest !== checkGrant.requiredCoverageDigest) { invalid("growth-authority-coverage-mismatch"); }
  return { kind: "receipt", receipt: { ...result, provenance: { grant: checkGrant, completion } } };
}

function validateGrantEnvelope(row: Record<string, unknown>, now: Date): { issuedAt: string; expiresAt: string } {
  const issuedAt = date(row["issuedAt"]), expiresAt = date(row["expiresAt"]);
  if (Date.parse(issuedAt) > now.getTime() || Date.parse(expiresAt) <= now.getTime() || Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    invalid("growth-authority-grant-expired");
  }
  const collections = [row["released"], row["ownerEvidence"], row["archives"], row["candidates"]];
  if (collections.some((entry) => !Array.isArray(entry) || entry.length > 10_000)) { invalid("growth-authority-grant-invalid"); }
  if (!Array.isArray(row["requiredPhases"])) { invalid("growth-authority-phases-invalid"); }
  exact(row["requiredPhases"], growthAuthorityRequiredPhases, "growth-authority-phases-invalid");
  return { issuedAt, expiresAt };
}

/** Validates protocol framing and exact request bindings. Content schemas are
 * validated by the verified context adapter before application policy sees it. */
export function validateGrowthAuthorityGrant(value: unknown, request: GrowthAuthorityRequest, fingerprint: ChangeFingerprint,
  inspection: ProxyInspection, now: Date): GrowthAuthorityGrant {
  const row = object(value, ["schemaVersion", "kind", "grantId", "requestDigest", "admissionReceipt", "binding", "workflowRef", "runRef", "issuedAt", "expiresAt",
    "trustedBase", "trustedBaseReference", "retainedHistory", "released", "ownerEvidence", "archives", "candidates", "metadataRoots", "requiredCoverageDigest", "requiredPhases"]);
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
  const historyValue = row["retainedHistory"];
  const history = object(historyValue, ["targetSource", "targetSurfaceDigest", "receiptDigest", "custodyEvidenceDigest", "custodyEvidence"]);
  const targetSource = source(history["targetSource"]);
  exact(targetSource, { commit: trustedBase.sourceCommit, tree: trustedBase.sourceTree }, "growth-authority-history-source-mismatch");
  if (digest(history["targetSurfaceDigest"]) !== trustedBaseReference.surfaceDigest) { invalid("growth-authority-history-target-mismatch"); }

  const releasedInput = row["released"] as unknown[], ownerInput = row["ownerEvidence"] as unknown[];
  const archiveInput = row["archives"] as unknown[], candidateInput = row["candidates"] as unknown[];
  const releasedRows = releasedInput.map((entry) => validateReleased(entry, binding.invocation.repository, inspection));
  const ownerRows = ownerInput.map(validateOwnerEvidence);
  const archiveRows = archiveInput.map((entry) => validatePackedEvidence(entry, binding.invocation.repository, fingerprint));
  const candidateRows = candidateInput.map((entry) => validatePackedEvidence(entry, binding.invocation.repository, fingerprint));
  const historicalCustody = digest(history["custodyEvidenceDigest"]);
  const historicalEvidence = validateCustodyEvidence(history["custodyEvidence"], fingerprint);
  if (custodyDigest(historicalEvidence, fingerprint) !== historicalCustody) { invalid("growth-authority-history-custody-mismatch"); }
  const retainedBase = historicalEvidence.archiveManifest.find((file) => file.path === "trusted-base.json");
  if (retainedBase?.digest !== `sha256:${fingerprint.sha256(growthCanonicalJson(trustedBase))}`) {
    invalid("growth-authority-history-custody-mismatch");
  }
  const releasedByPackage = uniqueMap(releasedRows, (entry) => entry.packageName, "growth-authority-release-duplicate");
  uniqueMap(ownerRows, (entry) => entry.decisionId, "growth-authority-owner-duplicate");
  const archiveByPackage = uniqueMap(archiveRows, (entry) => entry.packageName, "growth-authority-archive-duplicate");
  const candidateByPackage = uniqueMap(candidateRows, (entry) => entry.packageName, "growth-authority-candidate-duplicate");
  const released = [...releasedByPackage.values()].toSorted((left, right) => left.packageName < right.packageName ? -1 : left.packageName > right.packageName ? 1 : 0);
  const ownerEvidence = ownerRows.toSorted((left, right) => left.decisionId < right.decisionId ? -1 : left.decisionId > right.decisionId ? 1 : 0);
  const archives = [...archiveByPackage.values()].toSorted((left, right) => left.packageName < right.packageName ? -1 : left.packageName > right.packageName ? 1 : 0);
  const candidates = [...candidateByPackage.values()].toSorted((left, right) => left.packageName < right.packageName ? -1 : left.packageName > right.packageName ? 1 : 0);
  const metadataRoots = validateGrowthMetadataRoots(row["metadataRoots"], { binding, base: trustedBase, requestDigest,
    releaseScope: new Set([...releasedByPackage.keys(), ...archiveByPackage.keys(), ...candidateByPackage.keys()]) }, fingerprint);

  exact(released.map((entry) => ({ packageName: entry.packageName, kind: entry.evidence.kind })),
    request.contextSelectors.released.map((entry) => ({ packageName: entry.packageName, kind: entry.kind })),
    "growth-authority-release-selector-mismatch");
  const requestedDecisions = new Set(request.decisionDigests);
  for (const owner of ownerEvidence) {
    if (owner.sourceBindingDigest !== requestDigest || !requestedDecisions.has(owner.decisionDigest)) {
      invalid("growth-authority-owner-source-mismatch");
    }
  }
  const packageNames = released.map((entry) => entry.packageName);
  exact(candidates.map((entry) => entry.packageName), packageNames, "growth-authority-candidate-scope-mismatch");
  const releasedPackageNames = released.filter((entry) => entry.evidence.kind === "released").map((entry) => entry.packageName);
  exact(archives.map((entry) => entry.packageName), releasedPackageNames, "growth-authority-archive-scope-mismatch");
  for (const releasedRow of released) {
    const candidate = candidateByPackage.get(releasedRow.packageName)!;
    const candidateInvocation = normalizeGrowthInvocation({
      repository: candidate.observation.repository,
      sourceCommit: candidate.observation.sourceCommit,
      sourceTree: candidate.observation.sourceTree,
      topologyDigest: candidate.observation.topologyDigest,
      lockDigest: candidate.observation.lockDigest,
      toolchainDigest: candidate.observation.toolchainDigest,
      artifactDigests: candidate.observation.artifactDigests,
      tool: candidate.observation.tool
    });
    exact(candidateInvocation, binding.invocation, "growth-authority-candidate-invocation-mismatch");
    exact(candidate.source, binding.target.evaluation, "growth-authority-candidate-source-mismatch");
    if (candidate.packageVersion !== releasedRow.releaseEvidence.packageVersion) {
      invalid("growth-authority-candidate-version-mismatch");
    }
    if (releasedRow.evidence.kind === "initial-unreleased") { continue; }
    const archive = archiveByPackage.get(releasedRow.packageName)!;
    if (releasedRow.evidence.typed.packageVersion !== releasedRow.evidence.artifact.packageVersion
      || archive.packageVersion !== releasedRow.evidence.artifact.packageVersion) {
      invalid("growth-authority-archive-version-mismatch");
    }
    if (releasedRow.observation === undefined) { invalid("growth-authority-release-observation-missing"); }
    exact(archive.observation, releasedRow.observation, "growth-authority-archive-observation-mismatch");
  }
  const evidenceManifestDigest = hashGrowthPayload({ domain: "foundation:sdk-growth:evidence-manifest:2", payload: {
    archives: archives.map((entry) => ({ packageName: entry.packageName, custodyEvidenceDigest: entry.custodyEvidenceDigest })),
    candidates: candidates.map((entry) => ({ packageName: entry.packageName, custodyEvidenceDigest: entry.custodyEvidenceDigest })),
    metadataRoots: metadataRoots.map((entry) => ({ packageName: entry.evidence.packageName, evidenceDigest: entry.evidenceDigest })),
    retainedHistory: historicalCustody
  } }, fingerprint);
  if (evidenceManifestDigest !== binding.evidenceManifestDigest) { invalid("growth-authority-evidence-manifest-mismatch"); }
  return { schemaVersion: growthAuthoritySchemaVersion, kind: "grant", grantId: text(row["grantId"]), requestDigest,
  admissionReceipt: validateAdmissionReceipt(row["admissionReceipt"], request, binding, fingerprint, { inspection, now }), binding,
    workflowRef: text(row["workflowRef"]), runRef: text(row["runRef"]), issuedAt, expiresAt, trustedBase, trustedBaseReference,
    retainedHistory: { targetSource, targetSurfaceDigest: digest(history["targetSurfaceDigest"]), receiptDigest: digest(history["receiptDigest"]),
      custodyEvidenceDigest: historicalCustody, custodyEvidence: historicalEvidence }, released, ownerEvidence, archives, candidates, metadataRoots,
    requiredCoverageDigest: digest(row["requiredCoverageDigest"]), requiredPhases: growthAuthorityRequiredPhases };
}

function validatePromotion(value: unknown): GrowthAuthorityReceipt["promotion"] {
  const row = object(value, member(value, "kind") === "none" ? ["kind"] : ["kind", "planDigest"]);
  if (row["kind"] === "none") { return { kind: "none" }; }
  if (row["kind"] === "plan") { return { kind: "plan", planDigest: digest(row["planDigest"]) }; }
  return invalid("growth-authority-promotion-invalid");
}
export function validateGrowthAuthorityReceipt(value: unknown, completion: GrowthAuthorityCompletion, operation: GrowthAuthorityRequest["operation"], fingerprint: ChangeFingerprint): GrowthAuthorityReceipt {
  const row = object(value, ["schemaVersion", "kind", "receiptId", "grantId", "grantDigest", "requestDigest", "completionDigest", "binding", "reportDigest",
    "coverageDigest", "phasesDigest", "verdict", "releaseEligible", "qualification", "operation", "promotion", "custodyRef", "issuedAt"]);
  if (row["schemaVersion"] !== growthAuthoritySchemaVersion || row["kind"] !== "receipt" || row["operation"] !== operation) { invalid("growth-authority-receipt-invalid"); }
  const binding = validateGrowthAuthorityBinding(row["binding"]), promotion = validatePromotion(row["promotion"]);
  exact(binding, completion.binding, "growth-authority-receipt-binding-mismatch");
  if ((operation === "check") !== (promotion.kind === "none")) { invalid("growth-authority-promotion-invalid"); }
  const verdict = row["verdict"], releaseEligible = row["releaseEligible"], qualification = row["qualification"];
  if ((verdict !== "admitted" && verdict !== "rejected" && verdict !== "incomplete") || typeof releaseEligible !== "boolean"
    || (qualification !== "qualified" && qualification !== "not-qualified")) { invalid("growth-authority-receipt-invalid"); }
  const receipt: GrowthAuthorityReceipt = { schemaVersion: growthAuthoritySchemaVersion, kind: "receipt", receiptId: text(row["receiptId"]),
    grantId: text(row["grantId"]), grantDigest: digest(row["grantDigest"]), requestDigest: digest(row["requestDigest"]),
    completionDigest: digest(row["completionDigest"]), binding,
    reportDigest: digest(row["reportDigest"]), coverageDigest: digest(row["coverageDigest"]), phasesDigest: digest(row["phasesDigest"]),
    verdict, releaseEligible, qualification, operation, promotion,
    custodyRef: text(row["custodyRef"]), issuedAt: date(row["issuedAt"]) };
  exact({ grantId: receipt.grantId, grantDigest: receipt.grantDigest, requestDigest: receipt.requestDigest,
    binding: receipt.binding, reportDigest: receipt.reportDigest, coverageDigest: receipt.coverageDigest,
    phasesDigest: receipt.phasesDigest, verdict: receipt.verdict, releaseEligible: receipt.releaseEligible,
    promotion: receipt.promotion }, { grantId: completion.grantId, grantDigest: completion.grantDigest, requestDigest: completion.requestDigest,
    binding: completion.binding, reportDigest: completion.reportDigest, coverageDigest: completion.coverageDigest,
    phasesDigest: completion.phasesDigest, verdict: completion.verdict, releaseEligible: completion.releaseEligible,
    promotion: completion.promotion }, "growth-authority-receipt-mismatch");
  if (receipt.completionDigest !== growthAuthorityCompletionDigest(completion, fingerprint)) { invalid("growth-authority-completion-mismatch"); }
  if ((receipt.qualification === "qualified") !== (receipt.verdict === "admitted" && receipt.releaseEligible)) { invalid("growth-authority-qualification-mismatch"); }
  return receipt;
}
