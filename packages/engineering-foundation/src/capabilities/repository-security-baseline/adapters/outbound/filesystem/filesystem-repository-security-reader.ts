import { opendir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { CapabilityInputError } from "../../../../../capability-runtime.js";
import { pathTraversesSymbolicLink } from "../../../../../filesystem-path-safety.js";
import { assertNotCancelled, parseStrictYamlSource } from "../../../../../strict-yaml.js";
import type {
  PublishablePackageEvidence,
  RepositorySecurityEvidence,
  RepositorySecurityPolicy,
  WorkflowEvidence,
  WorkflowJobEvidence,
  WorkflowPermission,
  WorkflowStepEvidence
} from "../../../application/model/repository-security.js";
import type { RepositorySecurityReader } from "../../../application/ports/repository-security-reader.js";

const MAX_FILE_BYTES = 4 * 1024 * 1024;

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "repository-security-evidence",
    retryable: false
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputError("REPOSITORY_SECURITY_EVIDENCE_INVALID", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function contained(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
}

async function safePath(
  root: string,
  repositoryPath: string,
  kind: "directory" | "file"
): Promise<string> {
  const candidate = resolve(root, repositoryPath);
  if (await pathTraversesSymbolicLink(root, candidate)) {
    inputError(
      "REPOSITORY_SECURITY_SYMLINK_PROHIBITED",
      `Security evidence cannot traverse a symbolic link: ${repositoryPath}.`
    );
  }
  const canonical = await realpath(candidate).catch(() =>
    inputError(
      "REPOSITORY_SECURITY_EVIDENCE_UNAVAILABLE",
      `Security evidence is unavailable: ${repositoryPath}.`
    )
  );
  if (!contained(root, canonical)) {
    inputError(
      "REPOSITORY_SECURITY_EVIDENCE_ESCAPE",
      `Security evidence escapes the repository: ${repositoryPath}.`
    );
  }
  const metadata = await stat(canonical);
  if (
    (kind === "directory" && !metadata.isDirectory()) ||
    (kind === "file" && (!metadata.isFile() || metadata.size > MAX_FILE_BYTES))
  ) {
    inputError(
      "REPOSITORY_SECURITY_EVIDENCE_INVALID",
      `Security evidence is not a valid ${kind}: ${repositoryPath}.`
    );
  }
  return canonical;
}

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
  const input = record(value, field);
  const result: Record<string, WorkflowPermission> = {};
  for (const [name, permission] of Object.entries(input)) {
    if (permission !== "none" && permission !== "read" && permission !== "write") {
      inputError(
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
      inputError("REPOSITORY_SECURITY_WORKFLOW_INVALID", "Workflow triggers must be strings.");
    }
    return Object.freeze(value.toSorted());
  }
  return Object.freeze(Object.keys(record(value, "workflow.on")).toSorted());
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
  const input = record(value, "workflow.on");
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

function steps(value: unknown, field: string): readonly WorkflowStepEvidence[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    inputError("REPOSITORY_SECURITY_WORKFLOW_INVALID", `${field} must be an array.`);
  }
  return Object.freeze(
    value.map((entry, index) => {
      const step = record(entry, `${field}[${index}]`);
      const stepInputs = step["with"];
      return Object.freeze({
        conditional: step["if"] !== undefined,
        nonBlocking:
          step["continue-on-error"] !== undefined &&
          step["continue-on-error"] !== false,
        inputs: Object.freeze(
          stepInputs === undefined
            ? {}
            : record(stepInputs, `${field}[${index}].with`)
        ),
        ...(typeof step["uses"] === "string" ? { uses: step["uses"] } : {}),
        ...(typeof step["run"] === "string" ? { run: step["run"] } : {})
      });
    })
  );
}

function workflow(path: string, source: string): WorkflowEvidence {
  const input = record(parseStrictYamlSource(source, `workflow:${path}`), `workflow ${path}`);
  const jobsInput = record(input["jobs"], `workflow ${path}.jobs`);
  const jobs: WorkflowJobEvidence[] = Object.entries(jobsInput).map(([id, value]) => {
    const job = record(value, `workflow ${path}.jobs.${id}`);
    const jobPermissions = permissions(
      job["permissions"],
      `workflow ${path}.jobs.${id}.permissions`
    );
    return Object.freeze({
      conditional: job["if"] !== undefined,
      nonBlocking:
        job["continue-on-error"] !== undefined &&
        job["continue-on-error"] !== false,
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
    ...(workflowPermissions === undefined ? {} : { permissions: workflowPermissions }),
    jobs: Object.freeze(jobs.toSorted((left, right) => left.id.localeCompare(right.id)))
  });
}

async function readWorkflowDirectory(
  root: string,
  policy: RepositorySecurityPolicy,
  signal?: AbortSignal
): Promise<readonly WorkflowEvidence[]> {
  const directory = await safePath(root, policy.workflowDirectory, "directory");
  const names: string[] = [];
  const handle = await opendir(directory);
  for await (const entry of handle) {
    assertNotCancelled(signal);
    if (entry.isSymbolicLink() || !entry.isFile() || !/\.ya?ml$/iu.test(entry.name)) {
      inputError(
        "REPOSITORY_SECURITY_WORKFLOW_ENTRY_INVALID",
        `Workflow directory contains an unsupported entry: ${entry.name}.`
      );
    }
    names.push(entry.name);
  }
  const evidence: WorkflowEvidence[] = [];
  for (const name of names.toSorted()) {
    const repositoryPath = `${policy.workflowDirectory}/${name}`;
    const file = await safePath(root, repositoryPath, "file");
    evidence.push(workflow(repositoryPath, await readFile(file, "utf8")));
  }
  return Object.freeze(evidence);
}

async function readPackage(
  root: string,
  manifestPath: string
): Promise<PublishablePackageEvidence> {
  const file = await safePath(root, manifestPath, "file");
  let input: unknown;
  try {
    input = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    inputError(
      "REPOSITORY_SECURITY_PACKAGE_INVALID",
      `Package manifest is not valid JSON: ${manifestPath}.`
    );
  }
  const manifest = record(input, `package manifest ${manifestPath}`);
  if (typeof manifest["name"] !== "string") {
    inputError(
      "REPOSITORY_SECURITY_PACKAGE_INVALID",
      `Publishable package name is invalid: ${manifestPath}.`
    );
  }
  const files = manifest["files"];
  if (files !== undefined && (!Array.isArray(files) || !files.every((entry) => typeof entry === "string"))) {
    inputError(
      "REPOSITORY_SECURITY_PACKAGE_INVALID",
      `Publishable package files must be strings: ${manifestPath}.`
    );
  }
  const publishConfig = manifest["publishConfig"];
  return Object.freeze({
    manifestPath,
    packageName: manifest["name"],
    ...(files === undefined ? {} : { files: Object.freeze(files) }),
    provenance:
      typeof publishConfig === "object" &&
      publishConfig !== null &&
      !Array.isArray(publishConfig) &&
      (publishConfig as Record<string, unknown>)["provenance"] === true
  });
}

export class FilesystemRepositorySecurityReader implements RepositorySecurityReader {
  async read(
    consumerRoot: string,
    policy: RepositorySecurityPolicy,
    signal?: AbortSignal
  ): Promise<RepositorySecurityEvidence> {
    assertNotCancelled(signal);
    const root = await realpath(consumerRoot).catch(() =>
      inputError("CONSUMER_ROOT_UNAVAILABLE", "Consumer root must be an accessible directory.")
    );
    const [workflows, packages] = await Promise.all([
      readWorkflowDirectory(root, policy, signal),
      Promise.all(
        policy.publishablePackageManifests.map((manifestPath) => readPackage(root, manifestPath))
      )
    ]);
    for (const requiredWorkflow of [policy.dependencyReviewWorkflow, policy.sbomWorkflow]) {
      if (!workflows.some(({ path }) => path === requiredWorkflow)) {
        inputError(
          "REPOSITORY_SECURITY_REQUIRED_WORKFLOW_UNAVAILABLE",
          `Required security workflow is not discovered: ${requiredWorkflow}.`
        );
      }
    }
    return Object.freeze({ workflows, packages: Object.freeze(packages) });
  }
}
