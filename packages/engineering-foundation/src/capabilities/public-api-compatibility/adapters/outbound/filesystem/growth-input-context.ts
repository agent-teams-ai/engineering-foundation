import type { GrowthInputContextPort } from "../../../application/ports/growth-input-context.js";
import type { GrowthInputContext, GrowthReleasedPackage } from "../../../application/model/growth-admission-context.js";
import type { GrowthEvidence, GrowthSurfaceObservation } from "../../../application/model/growth-observation.js";
import type { PublicApiCompatibilityPolicy, PublicApiSnapshot } from "../../../application/model/public-api.js";
import type { PublicApiRepository } from "../../../application/ports/public-api-repository.js";
import type { ChangeFingerprint } from "../../../application/ports/change-fingerprint.js";
import type { AcceptedDecisionEvidencePort } from "../../../application/ports/accepted-decision-evidence.js";
import { growthObservationReference, growthUniqueSorted, normalizeGrowthObservation } from "../../../application/policies/normalize-growth-observation.js";
import { configurationInputError } from "../../../application/configuration-input.js";
import type { PublicApiSchemaAssertion } from "../../schema-validation.js";
import { mapReleasedBaseline } from "./public-api-baseline-mapper.js";
import { auditRead } from "./public-api-audit-inputs.js";

function unavailable<T>(reason: string): GrowthEvidence<T> { return { status: "unavailable", reasons: [reason] }; }
function available<T>(value: T): GrowthEvidence<T> { return { status: "available", value }; }
/** Native JSON parsing owns syntax; this iterative token walk preserves object-key
 * occurrences (including escaped spellings) before any semantic validation. */
function parseContextJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const objects: (Set<string> | undefined)[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const token = text[index];
    if (token === "{") { objects.push(new Set()); }
    else if (token === "[") { objects.push(undefined); }
    else if (token === "}" || token === "]") { objects.pop(); }
    else if (token === '"') {
      const start = index;
      for (index += 1; index < text.length; index += 1) {
        if (text[index] === "\\") { index += 1; }
        else if (text[index] === '"') { break; }
      }
      let next = index + 1;
      while ([" ", "\t", "\r", "\n"].includes(text[next] ?? "")) { next += 1; }
      if (text[next] === ":") {
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        const keys = objects.at(-1);
        if (keys?.has(key)) { configurationInputError("SDK context input contains duplicate JSON object keys."); }
        keys?.add(key);
      }
    }
  }
  return value;
}

/** The shared audit reader predates typed failures. Match only its exact known
 * input failures, inside the read boundary; dependency defects still propagate. */
function inputUnavailableReason(error: unknown, path: string): string | undefined {
  if (!(error instanceof Error)) { return; }
  if (error.message === "Audit input file budget exhausted." || error.message === "Audit input byte budget exhausted.") {
    return "growth-input-budget-exhausted";
  }
  if ("code" in error && ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EIO", "ESTALE", "EBUSY", "EMFILE", "ENFILE"].includes(String(error.code))) {
    return error.code === "ENOENT" ? undefined : "growth-input-unavailable";
  }
  if (error.message === `Audit input changed: ${path}.` || error.message === `Audit input is not a regular file: ${path}.`) {
    return "growth-input-unavailable";
  }
  return;
}
function rejectVerifiedClaims(input: unknown): void {
  const pending = [input];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value !== null && typeof value === "object") {
      if ("status" in value && value.status === "verified") {
        configurationInputError("SDK filesystem inputs cannot contain verified authority claims.");
      }
      for (const nested of Object.values(value)) { pending.push(nested); }
    }
  }
}
function closed(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== fields.length || fields.some((field) => !Object.hasOwn(input, field))) {
    configurationInputError(`SDK context requires exactly: ${fields.join(", ")}.`);
  }
  return input as Record<string, unknown>;
}

/** Files establish content observations only. No disk record can establish
 * retained-history, initial-unreleased or owner authority before S3. */
export function createFilesystemGrowthInputContext(input: {
  readonly consumerRoot: string;
  readonly policy: PublicApiCompatibilityPolicy;
}, dependencies: {
  readonly repository: PublicApiRepository;
  readonly acceptedDecisionEvidence: AcceptedDecisionEvidencePort;
  readonly fingerprint: ChangeFingerprint;
  readonly assertSchema: PublicApiSchemaAssertion;
}): GrowthInputContextPort {
  const { consumerRoot, policy } = structuredClone(input);
  return {
    async read(rawRequest, cancellation): Promise<GrowthInputContext> {
      const request = structuredClone(rawRequest);
      const unavailableReasons = new Map<string, string>();
      const historicalBudget = { bytes: 0, files: 0 }, candidateBudget = { bytes: 0, files: 0 };
      async function json(path: string, budget: typeof historicalBudget): Promise<unknown> {
        cancellation.throwIfCancelled();
        let bytes: Uint8Array;
        try { bytes = await auditRead(consumerRoot, path, budget); }
        catch (error) {
          cancellation.throwIfCancelled();
          const reason = inputUnavailableReason(error, path);
          if (reason !== undefined) { unavailableReasons.set(path, reason); return undefined; }
          if (error instanceof Error && "code" in error && error.code === "ENOENT") { return undefined; }
          throw error;
        }
        cancellation.throwIfCancelled();
        let value: unknown;
        try { value = parseContextJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch (error) {
          if (error instanceof SyntaxError || error instanceof TypeError) { configurationInputError("SDK context input must be valid UTF-8 JSON."); }
          throw error;
        }
        rejectVerifiedClaims(value);
        return value;
      }
      const base = await json(request.trustedBasePath, historicalBudget);
      const trustedBase = base === undefined ? unavailable<GrowthSurfaceObservation>(unavailableReasons.get(request.trustedBasePath) ?? "growth-base-file-missing")
        : available(normalizeGrowthObservation(base as GrowthSurfaceObservation));
      const decisions = await json(request.decisionsPath, candidateBudget);
      if (decisions !== undefined && !Array.isArray(decisions)) { configurationInputError("SDK decisions must be a JSON array."); }
      const released: GrowthReleasedPackage[] = [];
      for (const row of growthUniqueSorted(request.released, (entry) => entry.packageName)) {
        cancellation.throwIfCancelled();
        const selected = policy.packages.find((pkg) => pkg.packageName === row.packageName)
          ?? configurationInputError(`SDK release package has no compatibility policy: ${row.packageName}.`);
        const releaseEvidence = available(await dependencies.repository.readReleaseEvidence(consumerRoot, policy.changesetDirectory, selected, cancellation.signal));
        if (row.kind === "initial-unreleased") {
          const raw = await json(row.trustedHistoryPath, historicalBudget);
          if (raw !== undefined) {
            const history = closed(raw, ["historyDigest"]);
            if (typeof history["historyDigest"] !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(history["historyDigest"])) {
              configurationInputError("SDK historyDigest must be a SHA-256 identity.");
            }
          }
          released.push({ packageName: row.packageName, policy: selected, releaseEvidence,
            evidence: { kind: "initial-unreleased", history: unavailable(unavailableReasons.get(row.trustedHistoryPath) ?? "growth-initial-history-unverified") } });
          continue;
        }
        const raw = await json(row.observationPath, historicalBudget);
        const pair = raw === undefined ? undefined : closed(raw, ["typed", "artifact"]);
        const missingReason = unavailableReasons.get(row.observationPath) ?? "growth-released-file-missing";
        async function branch(kind: "typed" | "artifact"): Promise<GrowthEvidence<PublicApiSnapshot>> {
          if (pair === undefined) { return unavailable(missingReason); }
          await dependencies.assertSchema("package-public-api-baseline/v1", pair[kind], "sdk-growth-released-context");
          return available(mapReleasedBaseline(pair[kind], selected));
        }
        released.push({ packageName: row.packageName, policy: selected, releaseEvidence,
          evidence: { kind: "released", typed: await branch("typed"), artifact: await branch("artifact") } });
      }
      const accepted = policy.governanceConfigPath === undefined ? { acceptedDecisionIds: [], acceptedDecisionPaths: [] }
        : await dependencies.acceptedDecisionEvidence.readAcceptedDecisionEvidence({ consumerRoot,
          baselinePath: policy.acceptedDecisionBaselinePath, governanceConfigPath: policy.governanceConfigPath,
          ...(cancellation.signal === undefined ? {} : { signal: cancellation.signal }) });
      cancellation.throwIfCancelled();
      return { trustedBase,
        trustedBaseReference: trustedBase.status === "available" ? available(growthObservationReference(trustedBase.value, dependencies.fingerprint)) : unavailable("growth-base-reference-missing"),
        retainedHistory: unavailable("growth-retained-history-unverified"), released, decisions: decisions ?? [],
        acceptedBreakingDecisions: { acceptedDecisionIds: accepted.acceptedDecisionIds, acceptedDecisionPaths: accepted.acceptedDecisionPaths,
          growthDecisionAuthority: unavailable("growth-owner-authority-unverified") },
        authority: { status: "unverified", reasons: ["growth-filesystem-authority-unverified", ...(decisions === undefined ? [unavailableReasons.get(request.decisionsPath) ?? "growth-decisions-file-missing"] : [])] } };
    }
  };
}
