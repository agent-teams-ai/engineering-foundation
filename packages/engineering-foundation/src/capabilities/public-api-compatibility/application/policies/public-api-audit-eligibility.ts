import {
  auditIdentityKey, PUBLIC_API_AUDIT_PROFILE,
  type AuditDeclaration, type AuditObservation, type AuditReference
} from "../model/public-api-observation.js";

export interface AuditEligibility {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}
function result(reasons: ReadonlySet<string>): AuditEligibility {
  return { eligible: reasons.size === 0, reasons: [...reasons].toSorted() };
}
function modelReasons(observation: AuditObservation): readonly string[] {
  if (!observation.modelExpected) {
    const invalid = observation.exportPath !== null || observation.modelPresent || observation.modelDigest !== undefined || observation.items.length > 0
      || observation.invocation.outcome !== "not-invoked" || observation.invocation.succeeded
      || observation.invocation.errorCount !== null || observation.invocation.warningCount !== null
      || observation.diagnostics.some((diagnostic) => diagnostic.source === "extractor");
    return invalid ? ["invalid-empty-export-observation"] : [];
  }
  const reasons: string[] = [];
  if (observation.exportPath === null) {reasons.push("missing-model-export-path");}
  if (!observation.modelPresent) {reasons.push("missing-model");}
  if (observation.modelPresent && observation.modelDigest === undefined) {reasons.push("missing-model-digest");}
  if (observation.invocation.outcome !== "completed") {reasons.push("incomplete-invocation");}
  return reasons;
}
// Check the runtime profile independently of the producer's literal TypeScript claim.
function supportedProfile(profile: unknown): boolean {
  return profile === PUBLIC_API_AUDIT_PROFILE;
}
function observationReasons(observation: AuditObservation): readonly string[] {
  const reasons: string[] = [];
  if (!observation.inputBytesRevalidated) {reasons.push("input-bytes-not-revalidated");}
  if (!observation.compilerDiagnosticsCollected) {reasons.push("compiler-diagnostics-unavailable");}
  reasons.push(...modelReasons(observation));
  if (!supportedProfile(observation.normalizationProfile)) {reasons.push("unsupported-profile");}
  const errors = observation.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.some((diagnostic) => diagnostic.source !== "extractor" || diagnostic.id !== "ae-forgotten-export")) {reasons.push("non-forgotten-export-error");}
  if (observation.modelExpected && !observation.invocation.succeeded && errors.length === 0) {reasons.push("unexplained-extraction-failure");}
  if (observation.modelExpected && observation.invocation.errorCount !== errors.filter((diagnostic) => diagnostic.source === "extractor").length) {reasons.push("incomplete-extractor-diagnostics");}
  return [...reasons, ...observation.unsupported];
}
function parentReasons(item: AuditDeclaration, observation: AuditObservation): readonly string[] {
  const reasons: string[] = [];
  const visited = new Set<string>();
  let cursor: AuditDeclaration | undefined = item;
  let expectedPublic = true;
  while (cursor !== undefined) {
    if (visited.has(cursor.identity.canonicalReference)) { reasons.push("parent-cycle"); break; }
    visited.add(cursor.identity.canonicalReference);
    expectedPublic &&= cursor.isExported !== false;
    if (cursor.parentKind === "EntryPoint") {break;}
    if (!["Namespace", "Class", "Interface", "Enum"].includes(cursor.parentKind)) {reasons.push("unsupported-parent-semantics");}
    const parent = observation.items.find((candidate) => candidate.identity.canonicalReference === cursor?.parentReference);
    if (parent === undefined || parent.kind !== cursor.parentKind) {reasons.push("unsupported-parent");}
    cursor = parent;
  }
  if (item.public !== expectedPublic) {reasons.push("inconsistent-parent-visibility");}
  return reasons;
}
function itemReasons(item: AuditDeclaration, observation: AuditObservation): readonly string[] {
  const reasons = [...parentReasons(item, observation)];
  if (item.identity.subject !== observation.subject || item.identity.packageName !== observation.packageName || item.identity.exportPath !== observation.exportPath) {reasons.push("invalid-scoped-identity");}
  if (item.parentKind === "EntryPoint" && item.isExported === null) {reasons.push("unsupported-root-visibility");}
  if (!item.excerpt.trim() && item.kind !== "Namespace") {reasons.push("empty-declaration-excerpt");}
  return reasons;
}
function referenceReasons(reference: AuditReference, observation: AuditObservation, identities: ReadonlySet<string>): readonly string[] {
  if (reference.resolution === "verified-external-library") {
    return reference.library === undefined || reference.library.declarations.length === 0 ? ["unverified-library"] : [];
  }
  if ((reference.resolution !== "local" && reference.resolution !== "same-subject-dependency") || reference.target === undefined || !identities.has(auditIdentityKey(reference.target))) {
    return ["incomplete-reference-resolution"];
  }
  const reasons: string[] = [];
  if (reference.target.subject !== observation.subject) {reasons.push("cross-subject-reference");}
  if (reference.resolution === "local" && (reference.target.packageName !== observation.packageName || reference.target.exportPath !== observation.exportPath)) {reasons.push("invalid-local-reference");}
  if (reference.resolution === "same-subject-dependency" && reference.target.packageName === observation.packageName) {reasons.push("invalid-dependency-reference");}
  return reasons;
}
/** Admission is Foundation-derived; extraction failure remains a separate failed gate. */
function publicApiAuditEligibility(observations: readonly AuditObservation[]): AuditEligibility {
  const reasons = new Set<string>();
  const identities = new Set<string>();
  if (observations.length === 0) {reasons.add("missing-observations");}
  const subject = observations[0]?.subject;
  for (const observation of observations) {
    if (observation.subject !== subject) {reasons.add("mixed-subjects");}
    for (const reason of observationReasons(observation)) {reasons.add(reason);}
    for (const item of observation.items) {
      const key = auditIdentityKey(item.identity);
      if (identities.has(key)) {reasons.add("duplicate-scoped-identity");}
      identities.add(key);
      for (const reason of itemReasons(item, observation)) {reasons.add(reason);}
    }
  }
  for (const observation of observations) {
    for (const reference of observation.items.flatMap((item) => item.references)) {
      for (const reason of referenceReasons(reference, observation, identities)) {reasons.add(reason);}
    }
  }
  return result(reasons);
}
function environments(observations: readonly AuditObservation[]): readonly string[] {
  return [...new Set(observations.map((observation) => observation.compilerEnvironment))].toSorted();
}
function libraries(observations: readonly AuditObservation[]): readonly string[] {
  return [...new Set(observations.flatMap((observation) => observation.externalDeclarations.map((file) => JSON.stringify([file.path, file.digest]))))].toSorted();
}
export function publicApiAuditPairEligibility(before: readonly AuditObservation[], after: readonly AuditObservation[]): AuditEligibility {
  const reasons = new Set([...publicApiAuditEligibility(before).reasons, ...publicApiAuditEligibility(after).reasons]);
  const tools = new Set([...before, ...after].map((observation) => observation.toolchain));
  if (tools.size !== 1) {reasons.add("toolchain-mismatch");}
  const packages = new Set([...before, ...after].map((observation) => observation.packageName));
  for (const packageName of packages) {
    const left = before.filter((observation) => observation.packageName === packageName);
    const right = after.filter((observation) => observation.packageName === packageName);
    if (left.length === 0 || right.length === 0) {continue;}
    if (JSON.stringify(environments(left)) !== JSON.stringify(environments(right))) {reasons.add("compiler-environment-mismatch");}
    if (JSON.stringify(libraries(left)) !== JSON.stringify(libraries(right))) {reasons.add("compiler-library-mismatch");}
  }
  return result(reasons);
}
