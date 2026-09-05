
import type {
  PresentRepositorySecurityToolEvidence,
  RepositorySecurityPolicy,
  RepositorySecurityToolEvidence,
  SecurityToolName
} from "../../../application/model/repository-security.js";
import { configuredRepositorySecurityTools } from "../../../application/model/repository-security.js";
import { digestEvidence } from "./repository-security-digests.js";
import {
  readOptionalEvidenceFile,
  readRequiredEvidenceFile
} from "./repository-security-filesystem.js";
import {
  repositorySecurityInputError,
  requireRecord
} from "../../../application/policies/repository-security-input.js";

const SHA_256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const EXACT_SEMANTIC_VERSION =
  /^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function toolEvidenceError(message: string): never {
  return repositorySecurityInputError("REPOSITORY_SECURITY_TOOL_EVIDENCE_INVALID", message);
}

function requireToolEvidenceString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    toolEvidenceError(`${field} must be a string.`);
  }
  return value;
}

function requireToolEvidenceDigest(value: unknown, field: string): string {
  const result = requireToolEvidenceString(value, field);
  if (!SHA_256_DIGEST.test(result)) {
    toolEvidenceError(`${field} must be a lowercase sha256 digest.`);
  }
  return result;
}

function requireToolEvidenceVersion(value: unknown, field: string): string {
  const result = requireToolEvidenceString(value, field);
  if (!EXACT_SEMANTIC_VERSION.test(result)) {
    toolEvidenceError(`${field} must be an exact semantic version.`);
  }
  return result;
}

function parseToolEvidence(
  source: Buffer,
  expectedTool: SecurityToolName
): Omit<
  PresentRepositorySecurityToolEvidence,
  | "actualConfigDigest"
  | "actualResultDigest"
  | "actualWorkflowDigest"
  | "evidencePath"
  | "resultPath"
> {
  let input: unknown;
  try {
    input = JSON.parse(source.toString("utf8")) as unknown;
  } catch {
    toolEvidenceError(`${expectedTool} evidence is not valid JSON.`);
  }
  const value = requireRecord(input, `${expectedTool} evidence`);
  const expectedFields = [
    "configDigest",
    "outcome",
    "resultDigest",
    "schemaVersion",
    "tool",
    "toolVersion",
    "workflowDigest"
  ];
  const fields = Object.keys(value).toSorted();
  if (
    fields.length !== expectedFields.length ||
    fields.some((field, index) => field !== expectedFields[index])
  ) {
    toolEvidenceError(`${expectedTool} evidence has unsupported or missing fields.`);
  }
  if (value["schemaVersion"] !== 1) {
    toolEvidenceError(`${expectedTool} evidence schemaVersion must be 1.`);
  }
  if (value["tool"] !== expectedTool) {
    toolEvidenceError(`${expectedTool} evidence tool identity is invalid.`);
  }
  const outcome = value["outcome"];
  if (outcome !== "passed" && outcome !== "failed") {
    toolEvidenceError(`${expectedTool} evidence outcome must be passed or failed.`);
  }
  return Object.freeze({
    kind: "present" as const,
    tool: expectedTool,
    configDigest: requireToolEvidenceDigest(
      value["configDigest"],
      `${expectedTool}.configDigest`
    ),
    outcome,
    resultDigest: requireToolEvidenceDigest(
      value["resultDigest"],
      `${expectedTool}.resultDigest`
    ),
    toolVersion: requireToolEvidenceVersion(
      value["toolVersion"],
      `${expectedTool}.toolVersion`
    ),
    workflowDigest: requireToolEvidenceDigest(
      value["workflowDigest"],
      `${expectedTool}.workflowDigest`
    )
  });
}

export async function readSecurityToolEvidence(
  root: string,
  policy: RepositorySecurityPolicy,
  currentWorkflowDigest: string
): Promise<readonly RepositorySecurityToolEvidence[]> {
  return Promise.all(
    configuredRepositorySecurityTools(policy.toolEvidence).map(async ({ policy: toolPolicy, tool }) => {
      const configSource = await readRequiredEvidenceFile(root, toolPolicy.configPath);
      const evidenceSource = await readOptionalEvidenceFile(root, toolPolicy.evidencePath);
      const resultSource = await readOptionalEvidenceFile(root, toolPolicy.resultPath);
      if (evidenceSource === undefined || resultSource === undefined) {
        return Object.freeze({
          kind: "missing" as const,
          missing: evidenceSource === undefined ? "evidence" : "result",
          tool,
          evidencePath: toolPolicy.evidencePath,
          resultPath: toolPolicy.resultPath
        });
      }
      const parsed = parseToolEvidence(evidenceSource, tool);
      return Object.freeze({
        ...parsed,
        actualConfigDigest: await digestEvidence(configSource),
        actualResultDigest: await digestEvidence(resultSource),
        actualWorkflowDigest: currentWorkflowDigest,
        evidencePath: toolPolicy.evidencePath,
        resultPath: toolPolicy.resultPath
      });
    })
  );
}
