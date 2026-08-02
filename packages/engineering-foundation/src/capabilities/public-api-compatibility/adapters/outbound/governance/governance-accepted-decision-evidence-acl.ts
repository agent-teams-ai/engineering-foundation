import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import { CapabilityInputError } from "../../../../../capability-runtime.js";
import { assertSchema } from "../../../../../schema-catalog.js";
import {
  assertNotCancelled,
  loadStrictYamlFile
} from "../../../../../strict-yaml.js";
import type { AcceptedDecisionEvidencePort } from "../../../application/ports/accepted-decision-evidence.js";

const ACCEPTED_DECISION_BASELINE_PATH =
  "architecture/decisions/accepted-decisions.json" as const;
const GOVERNANCE_ACCEPTED_DECISION_BASELINE_SCHEMA =
  "governance-architecture-decision-baseline/v1" as const;

function inputError(message: string): never {
  throw new CapabilityInputError({
    code: "PUBLIC_API_ACCEPTED_DECISION_EVIDENCE_INVALID",
    message,
    phase: "public-api-accepted-decision-evidence",
    retryable: false
  });
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputError(`${field} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function acceptedDecisionPaths(value: unknown): ReadonlySet<string> {
  const baseline = record(value, "accepted architecture decision baseline");
  const decisions = baseline["decisions"];
  if (!Array.isArray(decisions)) {
    inputError("accepted architecture decision baseline.decisions must be an array.");
  }
  const paths: string[] = [];
  const ids: string[] = [];
  const ordering: string[] = [];
  for (const [index, candidate] of decisions.entries()) {
    const decision = record(
      candidate,
      `accepted architecture decision baseline.decisions[${index}]`
    );
    const id = decision["id"];
    const path = decision["path"];
    const digest = decision["immutableDigest"];
    if (
      typeof id !== "string" ||
      typeof path !== "string" ||
      typeof digest !== "string"
    ) {
      inputError(
        `accepted architecture decision baseline.decisions[${index}] is invalid.`
      );
    }
    ids.push(id);
    paths.push(path);
    ordering.push(`${id}\u0000${path}`);
  }
  const sorted = ordering.toSorted(compareBinaryStrings);
  if (
    new Set(ids).size !== ids.length ||
    new Set(paths).size !== paths.length ||
    ordering.some((entry, index) => entry !== sorted[index])
  ) {
    inputError(
      "accepted architecture decision baseline entries must have unique paths and canonical order."
    );
  }
  return new Set(paths);
}

/**
 * ACL over governance's published immutable baseline. It deliberately does
 * not read an ADR document or import governance domain types, so a new raw
 * `Status: Accepted` file cannot authorize a breaking package API change.
 */
export class GovernanceAcceptedDecisionEvidenceAcl
  implements AcceptedDecisionEvidencePort
{
  async hasAcceptedDecision(input: {
    readonly consumerRoot: string;
    readonly decisionPath: string;
    readonly baselinePath: string;
    readonly signal?: AbortSignal;
  }): Promise<boolean> {
    if (input.baselinePath !== ACCEPTED_DECISION_BASELINE_PATH) {
      inputError(
        `Accepted decision evidence must use ${ACCEPTED_DECISION_BASELINE_PATH}.`
      );
    }
    const baseline = await loadStrictYamlFile(
      input.consumerRoot,
      input.baselinePath,
      "public-api-accepted-decision-evidence",
      input.signal
    );
    assertNotCancelled(input.signal);
    await assertSchema(
      GOVERNANCE_ACCEPTED_DECISION_BASELINE_SCHEMA,
      baseline,
      "public-api-accepted-decision-evidence"
    );
    assertNotCancelled(input.signal);
    return acceptedDecisionPaths(baseline).has(input.decisionPath);
  }
}
