import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import { parseStrictYamlSource } from "../../../../../strict-yaml.js";
import type {
  CompositeActionEvidence,
  WorkflowContainerEvidence,
  WorkflowEvidence,
  WorkflowJobEvidence,
  WorkflowPermission,
  WorkflowStepEvidence,
  WorkflowUseEvidence
} from "../../../application/model/repository-security.js";
import {
  repositorySecurityInputError,
  requireRecord
} from "./repository-security-input.js";

function permissions(
  value: unknown,
  field: string
): Readonly<Record<string, WorkflowPermission>> | "read-all" | "write-all" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "read-all" || value === "write-all") {
    return value;
  }
  const input = requireRecord(value, field);
  const result: Record<string, WorkflowPermission> = {};
  for (const [name, permission] of Object.entries(input)) {
    if (permission !== "none" && permission !== "read" && permission !== "write") {
      repositorySecurityInputError(
        "REPOSITORY_SECURITY_WORKFLOW_INVALID",
        `${field}.${name} must be none, read, or write.`
      );
    }
    result[name] = permission;
  }
  return Object.freeze(result);
}

function triggers(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === "string")) {
      repositorySecurityInputError(
        "REPOSITORY_SECURITY_WORKFLOW_INVALID",
        "Workflow triggers must be strings."
      );
    }
    return Object.freeze(value.toSorted());
  }
  return Object.freeze(Object.keys(requireRecord(value, "workflow.on")).toSorted());
}

function unconditionalTriggers(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return Object.freeze(
      value.filter((entry): entry is string => typeof entry === "string").toSorted()
    );
  }
  const input = requireRecord(value, "workflow.on");
  return Object.freeze(
    Object.entries(input)
      .filter(([, configuration]) => {
        if (configuration === null) {
          return true;
        }
        return (
          typeof configuration === "object" &&
          !Array.isArray(configuration) &&
          Object.keys(configuration).length === 0
        );
      })
      .map(([trigger]) => trigger)
      .toSorted()
  );
}

const PULL_REQUEST_CODE_CHANGE_TYPES = Object.freeze([
  "opened",
  "reopened",
  "synchronize"
]);

function pullRequestCodeChangesCovered(value: unknown): boolean {
  if (typeof value === "string") {
    return value === "pull_request";
  }
  if (Array.isArray(value)) {
    return value.includes("pull_request");
  }
  const input = requireRecord(value, "workflow.on");
  const configuration = input["pull_request"];
  if (configuration === null) {
    return true;
  }
  if (typeof configuration !== "object" || Array.isArray(configuration)) {
    return false;
  }
  const pullRequest = requireRecord(configuration, "workflow.on.pull_request");
  const keys = Object.keys(pullRequest);
  if (keys.length === 0) {
    return true;
  }
  const types = pullRequest["types"];
  return (
    keys.length === 1 &&
    Array.isArray(types) &&
    types.every((entry) => typeof entry === "string") &&
    PULL_REQUEST_CODE_CHANGE_TYPES.every((required) => types.includes(required))
  );
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_WORKFLOW_INVALID",
      `${field} must be a non-empty string.`
    );
  }
  return value;
}

function containerImage(value: unknown, field: string): string {
  if (typeof value === "string") {
    return requiredString(value, field);
  }
  return requiredString(requireRecord(value, field)["image"], `${field}.image`);
}

function containers(value: Record<string, unknown>, field: string): readonly WorkflowContainerEvidence[] {
  const discovered: WorkflowContainerEvidence[] = [];
  if (value["container"] !== undefined) {
    discovered.push(
      Object.freeze({
        image: containerImage(value["container"], `${field}.container`),
        name: "container",
        scope: "job"
      })
    );
  }
  if (value["services"] !== undefined) {
    const services = requireRecord(value["services"], `${field}.services`);
    for (const [name, service] of Object.entries(services).toSorted(([left], [right]) =>
      compareBinaryStrings(left, right)
    )) {
      discovered.push(
        Object.freeze({
          image: containerImage(service, `${field}.services.${name}`),
          name,
          scope: "service"
        })
      );
    }
  }
  return Object.freeze(discovered);
}

function needs(value: unknown, field: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  const entries: unknown = typeof value === "string" ? [value] : value;
  if (!Array.isArray(entries)) {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_WORKFLOW_INVALID",
      `${field} must be a non-empty job ID or an array of non-empty job IDs.`
    );
  }
  const normalized = entries.map((entry, index) =>
    requiredString(entry, `${field}[${index}]`)
  );
  if (new Set(normalized).size !== normalized.length) {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_WORKFLOW_INVALID",
      `${field} cannot declare duplicate job IDs.`
    );
  }
  return Object.freeze(normalized);
}

function condition(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_WORKFLOW_INVALID",
      `${field} must be a non-empty expression or boolean.`
    );
  }
  return value;
}

function steps(value: unknown, field: string): readonly WorkflowStepEvidence[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_WORKFLOW_INVALID",
      `${field} must be an array.`
    );
  }
  return Object.freeze(
    value.map((entry, index) => {
      const step = requireRecord(entry, `${field}[${index}]`);
      const stepInputs = step["with"];
      const stepCondition = condition(step["if"], `${field}[${index}].if`);
      return Object.freeze({
        conditional: stepCondition !== undefined,
        ...(stepCondition === undefined ? {} : { condition: stepCondition }),
        nonBlocking:
          step["continue-on-error"] !== undefined && step["continue-on-error"] !== false,
        inputs: Object.freeze(
          stepInputs === undefined ? {} : requireRecord(stepInputs, `${field}[${index}].with`)
        ),
        ...(typeof step["uses"] === "string" ? { uses: step["uses"] } : {}),
        ...(typeof step["run"] === "string" ? { run: step["run"] } : {})
      });
    })
  );
}

export function parseWorkflow(path: string, source: string): WorkflowEvidence {
  const input = requireRecord(parseStrictYamlSource(source, `workflow:${path}`), `workflow ${path}`);
  const jobsInput = requireRecord(input["jobs"], `workflow ${path}.jobs`);
  const jobs: WorkflowJobEvidence[] = Object.entries(jobsInput).map(([id, value]) => {
    const job = requireRecord(value, `workflow ${path}.jobs.${id}`);
    const jobPermissions = permissions(
      job["permissions"],
      `workflow ${path}.jobs.${id}.permissions`
    );
    const jobCondition = condition(job["if"], `workflow ${path}.jobs.${id}.if`);
    return Object.freeze({
      conditional: jobCondition !== undefined,
      ...(jobCondition === undefined ? {} : { condition: jobCondition }),
      containers: containers(job, `workflow ${path}.jobs.${id}`),
      needs: needs(job["needs"], `workflow ${path}.jobs.${id}.needs`),
      nonBlocking:
        job["continue-on-error"] !== undefined && job["continue-on-error"] !== false,
      id,
      ...(typeof job["uses"] === "string" ? { uses: job["uses"] } : {}),
      ...(jobPermissions === undefined ? {} : { permissions: jobPermissions }),
      steps: steps(job["steps"], `workflow ${path}.jobs.${id}.steps`)
    });
  });
  const workflowPermissions = permissions(input["permissions"], `workflow ${path}.permissions`);
  return Object.freeze({
    path,
    triggers: triggers(input["on"]),
    unconditionalTriggers: unconditionalTriggers(input["on"]),
    pullRequestCodeChangesCovered: pullRequestCodeChangesCovered(input["on"]),
    ...(workflowPermissions === undefined ? {} : { permissions: workflowPermissions }),
    jobs: Object.freeze(jobs.toSorted((left, right) => compareBinaryStrings(left.id, right.id)))
  });
}

export function collectWorkflowUses(
  workflows: readonly WorkflowEvidence[]
): readonly WorkflowUseEvidence[] {
  const uses: WorkflowUseEvidence[] = [];
  for (const workflow of workflows) {
    for (const job of workflow.jobs) {
      if (job.uses !== undefined) {
        uses.push({
          path: workflow.path,
          subject: `${workflow.path}:jobs.${job.id}`,
          uses: job.uses
        });
      }
      for (const [index, step] of job.steps.entries()) {
        if (step.uses !== undefined) {
          uses.push({
            path: workflow.path,
            subject: `${workflow.path}:jobs.${job.id}.steps[${index}]`,
            uses: step.uses
          });
        }
      }
    }
  }
  return Object.freeze(uses);
}

export function collectCompositeActionUses(
  path: string,
  source: Uint8Array
): CompositeActionEvidence {
  const input = requireRecord(
    parseStrictYamlSource(Buffer.from(source).toString("utf8"), `composite-action:${path}`),
    `composite action ${path}`
  );
  const runs = requireRecord(input["runs"], `composite action ${path}.runs`);
  if (runs["using"] !== "composite") {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_LOCAL_ACTION_RUNTIME_UNSUPPORTED",
      `Local action must use the auditable composite runtime: ${path}.`
    );
  }
  const compositeSteps = steps(runs["steps"], `composite action ${path}.runs.steps`);
  return Object.freeze({
    path,
    steps: compositeSteps
  });
}

export function collectCompositeActionWorkflowUses(
  action: CompositeActionEvidence
): readonly WorkflowUseEvidence[] {
  return Object.freeze(
    action.steps.flatMap((step, index) =>
      step.uses === undefined
        ? []
        : [
            {
              path: action.path,
              subject: `${action.path}:runs.steps[${index}]`,
              uses: step.uses
            }
          ]
    )
  );
}
