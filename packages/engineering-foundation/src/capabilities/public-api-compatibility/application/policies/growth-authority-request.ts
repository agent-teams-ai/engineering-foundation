import type {
  GrowthAuthorityBinding,
  GrowthAuthorityRepository,
  GrowthAuthorityRequest,
} from "../model/growth-authority.js";
import {
  growthAuthorityRequiredPhases,
  growthAuthoritySchemaVersion,
} from "../model/growth-authority.js";

import { growthUniqueSorted, normalizeGrowthInvocation } from "./normalize-growth-observation.js";
import {
  commit,
  digest,
  exact,
  exactVersion,
  integrity,
  invalid,
  member,
  object,
  repositoryPath,
  source,
  text,
  uniqueMap,
} from "./validate-growth-authority-primitives.js";

export function growthAuthorityRepositoryIdentity(repository: GrowthAuthorityRepository): string {
  return `${repository.provider}:${repository.repositoryId}`;
}
function validateRepository(value: unknown): GrowthAuthorityRepository {
  const row = object(value, ["provider", "repositoryId", "owner", "name"]);
  const provider = text(row["provider"]),
    repositoryId = text(row["repositoryId"]);
  if (!/^[a-z][a-z0-9.-]*$/u.test(provider) || !/^(?:0|[1-9]\d*)$/u.test(repositoryId)) {
    invalid("growth-authority-repository-invalid");
  }
  return { provider, repositoryId, owner: text(row["owner"]), name: text(row["name"]) };
}

export function validateGrowthAuthorityBinding(value: unknown): GrowthAuthorityBinding {
  const row = object(value, [
    "invocation",
    "target",
    "verifier",
    "tool",
    "policy",
    "historyDigest",
    "evidenceManifestDigest",
  ]);
  const targetRow = object(row["target"], [
    "repository",
    "pullRequestNumber",
    "head",
    "base",
    "mergeBase",
    "evaluation",
    "evaluationKind",
  ]);
  const repository = validateRepository(targetRow["repository"]),
    pullRequestNumber = targetRow["pullRequestNumber"];
  if (!Number.isSafeInteger(pullRequestNumber) || (pullRequestNumber as number) <= 0) {
    invalid("growth-authority-pr-invalid");
  }
  if (!["head", "merge-result", "release-preimage"].includes(String(targetRow["evaluationKind"]))) {
    invalid("growth-authority-evaluation-kind-invalid");
  }
  const head = source(targetRow["head"]),
    base = source(targetRow["base"]),
    mergeBase = source(targetRow["mergeBase"]),
    evaluation = source(targetRow["evaluation"]);
  if (targetRow["evaluationKind"] === "head") {
    exact(evaluation, head, "growth-authority-evaluation-mismatch");
  }
  const verifier = object(row["verifier"], ["identity", "immutableRevision", "artifactDigest"]);
  const tool = object(row["tool"], [
    "packageName",
    "version",
    "archiveDigest",
    "archiveIntegrity",
    "distributionDigest",
    "extractorVersion",
  ]);
  if (tool["packageName"] !== "@agent-teams/engineering-foundation") {
    invalid("growth-authority-tool-invalid");
  }
  const policy = object(row["policy"], [
    "contractRevision",
    "policyVersion",
    "enrollmentRevision",
    "configurationDigest",
    "scopeDigest",
    "commandDigest",
  ]);
  if (
    policy["contractRevision"] !== "foundation:sdk-growth:c0:5" ||
    policy["policyVersion"] !== "foundation:sdk-growth:policy:1"
  ) {
    invalid("growth-authority-policy-invalid");
  }
  const invocation = normalizeGrowthInvocation(
    row["invocation"] as GrowthAuthorityBinding["invocation"],
  );
  if (
    invocation.repository !== growthAuthorityRepositoryIdentity(repository) ||
    invocation.sourceCommit !== evaluation.commit ||
    invocation.sourceTree !== evaluation.tree
  ) {
    invalid("growth-authority-evaluation-mismatch");
  }
  const version = exactVersion(tool["version"]),
    extractorVersion = text(tool["extractorVersion"]),
    distributionDigest = digest(tool["distributionDigest"]);
  if (
    version !== invocation.tool.version ||
    extractorVersion !== invocation.tool.extractorVersion ||
    distributionDigest !== invocation.tool.artifactDigest
  ) {
    invalid("growth-authority-tool-binding-mismatch");
  }
  return {
    invocation,
    target: {
      repository,
      pullRequestNumber: pullRequestNumber as number,
      head,
      base,
      mergeBase,
      evaluation,
      evaluationKind: targetRow[
        "evaluationKind"
      ] as GrowthAuthorityBinding["target"]["evaluationKind"],
    },
    verifier: {
      identity: text(verifier["identity"]),
      immutableRevision: commit(verifier["immutableRevision"]),
      artifactDigest: digest(verifier["artifactDigest"]),
    },
    tool: {
      packageName: "@agent-teams/engineering-foundation",
      version,
      archiveDigest: digest(tool["archiveDigest"]),
      archiveIntegrity: integrity(tool["archiveIntegrity"]),
      distributionDigest,
      extractorVersion,
    },
    policy: {
      contractRevision: "foundation:sdk-growth:c0:5",
      policyVersion: "foundation:sdk-growth:policy:1",
      enrollmentRevision: commit(policy["enrollmentRevision"]),
      configurationDigest: digest(policy["configurationDigest"]),
      scopeDigest: digest(policy["scopeDigest"]),
      commandDigest: digest(policy["commandDigest"]),
    },
    historyDigest: digest(row["historyDigest"]),
    evidenceManifestDigest: digest(row["evidenceManifestDigest"]),
  };
}

function validateSelectors(value: unknown): GrowthAuthorityRequest["contextSelectors"] {
  const row = object(structuredClone(value), ["trustedBasePath", "decisionsPath", "released"]);
  if (!Array.isArray(row["released"]) || row["released"].length > 10_000) {
    invalid("growth-authority-selectors-invalid");
  }
  const released = row["released"].map((entry) => {
    const kind = member(entry, "kind");
    if (kind !== "released" && kind !== "initial-unreleased") {
      return invalid("growth-authority-selectors-invalid");
    }
    const wire = object(
      entry,
      kind === "released"
        ? ["packageName", "kind", "observationPath"]
        : ["packageName", "kind", "trustedHistoryPath"],
    );
    const packageName = text(wire["packageName"]);
    return kind === "released"
      ? {
          packageName,
          kind: "released" as const,
          observationPath: repositoryPath(wire["observationPath"]),
        }
      : {
          packageName,
          kind: "initial-unreleased" as const,
          trustedHistoryPath: repositoryPath(wire["trustedHistoryPath"]),
        };
  });
  uniqueMap(released, (entry) => entry.packageName, "growth-authority-selector-duplicate");
  return {
    trustedBasePath: repositoryPath(row["trustedBasePath"]),
    decisionsPath: repositoryPath(row["decisionsPath"]),
    released: growthUniqueSorted(released, (entry) => entry.packageName),
  };
}
export function validateGrowthAuthorityRequest(value: unknown): GrowthAuthorityRequest {
  const row = object(value, [
    "schemaVersion",
    "kind",
    "operation",
    "admissionReceiptId",
    "binding",
    "contextSelectors",
    "decisionDigests",
    "requiredPhases",
  ]);
  if (
    row["schemaVersion"] !== growthAuthoritySchemaVersion ||
    row["kind"] !== "request" ||
    !["check", "promote-release"].includes(String(row["operation"]))
  ) {
    invalid("growth-authority-request-invalid");
  }
  if (!Array.isArray(row["decisionDigests"]) || row["decisionDigests"].length > 10_000) {
    invalid("growth-authority-decision-budget-exhausted");
  }
  const decisionDigests = row["decisionDigests"].map(digest);
  if (new Set(decisionDigests).size !== decisionDigests.length) {
    invalid("growth-authority-decision-duplicate");
  }
  if (
    (row["operation"] === "check" && row["admissionReceiptId"] !== null) ||
    (row["operation"] === "promote-release" &&
      (typeof row["admissionReceiptId"] !== "string" || row["admissionReceiptId"].trim() === ""))
  ) {
    invalid("growth-authority-admission-receipt-invalid");
  }
  if (!Array.isArray(row["requiredPhases"])) {
    invalid("growth-authority-phases-invalid");
  }
  exact(row["requiredPhases"], growthAuthorityRequiredPhases, "growth-authority-phases-invalid");
  return {
    schemaVersion: growthAuthoritySchemaVersion,
    kind: "request",
    operation: row["operation"] as GrowthAuthorityRequest["operation"],
    admissionReceiptId: row["admissionReceiptId"] as string | null,
    binding: validateGrowthAuthorityBinding(row["binding"]),
    contextSelectors: validateSelectors(row["contextSelectors"]),
    decisionDigests: growthUniqueSorted(decisionDigests, (entry) => entry),
    requiredPhases: growthAuthorityRequiredPhases,
  };
}
