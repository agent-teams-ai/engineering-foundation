import { opendir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { CapabilityInputError } from "../../../../../capability-runtime.js";
import { pathTraversesSymbolicLink } from "../../../../../filesystem-path-safety.js";
import { assertNotCancelled, parseStrictYamlSource } from "../../../../../strict-yaml.js";
import type {
  PublishablePackageEvidence,
  PresentRepositorySecurityToolEvidence,
  RepositorySecurityEvidence,
  RepositorySecurityPolicy,
  RepositorySecurityToolEvidence,
  SecurityToolName,
  WorkflowEvidence,
  WorkflowJobEvidence,
  WorkflowPermission,
  WorkflowStepEvidence,
  WorkflowUseEvidence
} from "../../../application/model/repository-security.js";
import {
  configuredRepositorySecurityTools,
  isSafeLocalWorkflowUse
} from "../../../application/model/repository-security.js";
import type { RepositorySecurityReader } from "../../../application/ports/repository-security-reader.js";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_WORKFLOW_DIGEST_BYTES = 32 * 1024 * 1024;
const SHA_256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const EXACT_SEMANTIC_VERSION =
  /^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

interface WorkflowDirectoryEvidence {
  readonly workflows: readonly WorkflowEvidence[];
  readonly workflowUses: readonly WorkflowUseEvidence[];
  readonly workflowDigest: string;
}

interface LocalCompositeActionEvidence {
  readonly sourceEntries: readonly { readonly path: string; readonly source: Uint8Array }[];
  readonly workflowUses: readonly WorkflowUseEvidence[];
}

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

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

async function optionalSafeFile(root: string, repositoryPath: string): Promise<string | undefined> {
  const candidate = resolve(root, repositoryPath);
  if (await pathTraversesSymbolicLink(root, candidate)) {
    inputError(
      "REPOSITORY_SECURITY_SYMLINK_PROHIBITED",
      `Security evidence cannot traverse a symbolic link: ${repositoryPath}.`
    );
  }
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    inputError(
      "REPOSITORY_SECURITY_EVIDENCE_UNAVAILABLE",
      `Security evidence is unavailable: ${repositoryPath}.`
    );
  }
  if (!contained(root, canonical)) {
    inputError(
      "REPOSITORY_SECURITY_EVIDENCE_ESCAPE",
      `Security evidence escapes the repository: ${repositoryPath}.`
    );
  }
  const metadata = await stat(canonical);
  if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) {
    inputError(
      "REPOSITORY_SECURITY_EVIDENCE_INVALID",
      `Security evidence is not a valid file: ${repositoryPath}.`
    );
  }
  return canonical;
}

async function readOptionalFile(root: string, repositoryPath: string): Promise<Buffer | undefined> {
  const file = await optionalSafeFile(root, repositoryPath);
  return file === undefined ? undefined : readFile(file);
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function digestParts(parts: readonly Uint8Array[]): Promise<string> {
  const totalBytes = parts.reduce((total, part) => total + part.byteLength, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_WORKFLOW_DIGEST_BYTES) {
    inputError(
      "REPOSITORY_SECURITY_EVIDENCE_TOO_LARGE",
      "Security workflow sources exceed the supported digest input size."
    );
  }
  const source = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    source.set(part, offset);
    offset += part.byteLength;
  }
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", source.buffer));
  return `sha256:${Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

async function digest(value: Uint8Array): Promise<string> {
  return digestParts([value]);
}

async function workflowDigest(
  entries: readonly { readonly path: string; readonly source: Uint8Array }[]
): Promise<string> {
  const parts: Uint8Array[] = [encode("repository-security-workflows-v1\u0000")];
  for (const entry of entries.toSorted((left, right) => left.path.localeCompare(right.path))) {
    parts.push(
      encode(entry.path),
      encode("\u0000"),
      encode(String(entry.source.byteLength)),
      encode("\u0000"),
      entry.source,
      encode("\u0000")
    );
  }
  return digestParts(parts);
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

function workflowUses(workflows: readonly WorkflowEvidence[]): readonly WorkflowUseEvidence[] {
  const uses: WorkflowUseEvidence[] = [];
  for (const workflowEvidence of workflows) {
    for (const job of workflowEvidence.jobs) {
      if (job.uses !== undefined) {
        uses.push({
          path: workflowEvidence.path,
          subject: `${workflowEvidence.path}:jobs.${job.id}`,
          uses: job.uses
        });
      }
      for (const [index, step] of job.steps.entries()) {
        if (step.uses !== undefined) {
          uses.push({
            path: workflowEvidence.path,
            subject: `${workflowEvidence.path}:jobs.${job.id}.steps[${index}]`,
            uses: step.uses
          });
        }
      }
    }
  }
  return Object.freeze(uses);
}

function compositeActionUses(path: string, source: Uint8Array): readonly WorkflowUseEvidence[] {
  const input = record(
    parseStrictYamlSource(Buffer.from(source).toString("utf8"), `composite-action:${path}`),
    `composite action ${path}`
  );
  const runs = record(input["runs"], `composite action ${path}.runs`);
  if (runs["using"] !== "composite") {
    return Object.freeze([]);
  }
  const compositeSteps = steps(runs["steps"], `composite action ${path}.runs.steps`);
  return Object.freeze(
    compositeSteps.flatMap((step, index) =>
      step.uses === undefined
        ? []
        : [
            {
              path,
              subject: `${path}:runs.steps[${index}]`,
              uses: step.uses
            }
          ]
    )
  );
}

function isReusableWorkflowUse(use: string, workflowDirectory: string): boolean {
  const repositoryPath = use.slice(2);
  return (
    repositoryPath.startsWith(`${workflowDirectory}/`) &&
    /\.ya?ml$/iu.test(repositoryPath)
  );
}

async function compositeActionDescriptor(
  root: string,
  localUse: string
): Promise<{ readonly path: string; readonly source: Uint8Array }> {
  const actionDirectory = localUse.slice(2);
  await safePath(root, actionDirectory, "directory");
  const candidates = await Promise.all(
    ["action.yml", "action.yaml"].map(async (name) => {
      const path = `${actionDirectory}/${name}`;
      const file = await optionalSafeFile(root, path);
      return file === undefined ? undefined : { path, source: await readFile(file) };
    })
  );
  const descriptors = candidates.flatMap((candidate) =>
    candidate === undefined ? [] : [candidate]
  );
  if (descriptors.length !== 1) {
    inputError(
      "REPOSITORY_SECURITY_LOCAL_ACTION_INVALID",
      `Local action must declare exactly one action.yml or action.yaml descriptor: ${localUse}.`
    );
  }
  const descriptor = descriptors[0];
  if (descriptor === undefined) {
    inputError(
      "REPOSITORY_SECURITY_LOCAL_ACTION_INVALID",
      `Local action descriptor is unavailable: ${localUse}.`
    );
  }
  return descriptor;
}

async function readLocalCompositeActions(
  root: string,
  workflowDirectory: string,
  rootUses: readonly WorkflowUseEvidence[]
): Promise<LocalCompositeActionEvidence> {
  const pending = rootUses
    .filter(
      ({ uses }) => isSafeLocalWorkflowUse(uses) && !isReusableWorkflowUse(uses, workflowDirectory)
    )
    .toSorted(({ uses: left }, { uses: right }) => left.localeCompare(right));
  const visited = new Set<string>();
  const sourceEntries: { path: string; source: Uint8Array }[] = [];
  const nestedUses: WorkflowUseEvidence[] = [];
  while (pending.length > 0) {
    const next = pending.shift();
    if (next === undefined || visited.has(next.uses)) {
      continue;
    }
    visited.add(next.uses);
    const descriptor = await compositeActionDescriptor(root, next.uses);
    sourceEntries.push(descriptor);
    const discovered = compositeActionUses(descriptor.path, descriptor.source);
    nestedUses.push(...discovered);
    for (const candidate of discovered) {
      if (
        isSafeLocalWorkflowUse(candidate.uses) &&
        !isReusableWorkflowUse(candidate.uses, workflowDirectory)
      ) {
        pending.push(candidate);
      }
    }
  }
  return Object.freeze({
    sourceEntries: Object.freeze(sourceEntries),
    workflowUses: Object.freeze(nestedUses)
  });
}

function toolEvidenceError(message: string): never {
  return inputError("REPOSITORY_SECURITY_TOOL_EVIDENCE_INVALID", message);
}

function toolEvidenceString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    toolEvidenceError(`${field} must be a string.`);
  }
  return value;
}

function toolEvidenceDigest(value: unknown, field: string): string {
  const result = toolEvidenceString(value, field);
  if (!SHA_256_DIGEST.test(result)) {
    toolEvidenceError(`${field} must be a lowercase sha256 digest.`);
  }
  return result;
}

function toolEvidenceVersion(value: unknown, field: string): string {
  const result = toolEvidenceString(value, field);
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
  const value = record(input, `${expectedTool} evidence`);
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
    configDigest: toolEvidenceDigest(value["configDigest"], `${expectedTool}.configDigest`),
    outcome,
    resultDigest: toolEvidenceDigest(value["resultDigest"], `${expectedTool}.resultDigest`),
    toolVersion: toolEvidenceVersion(value["toolVersion"], `${expectedTool}.toolVersion`),
    workflowDigest: toolEvidenceDigest(value["workflowDigest"], `${expectedTool}.workflowDigest`)
  });
}

async function readToolEvidence(
  root: string,
  policy: RepositorySecurityPolicy,
  currentWorkflowDigest: string
): Promise<readonly RepositorySecurityToolEvidence[]> {
  return Promise.all(
    configuredRepositorySecurityTools(policy.toolEvidence).map(async ({ policy: toolPolicy, tool }) => {
      const configSource = await readFile(
        await safePath(root, toolPolicy.configPath, "file")
      );
      const evidenceSource = await readOptionalFile(root, toolPolicy.evidencePath);
      const resultSource = await readOptionalFile(root, toolPolicy.resultPath);
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
        actualConfigDigest: await digest(configSource),
        actualResultDigest: await digest(resultSource),
        actualWorkflowDigest: currentWorkflowDigest,
        evidencePath: toolPolicy.evidencePath,
        resultPath: toolPolicy.resultPath
      });
    })
  );
}

async function readWorkflowDirectory(
  root: string,
  policy: RepositorySecurityPolicy,
  signal?: AbortSignal
): Promise<WorkflowDirectoryEvidence> {
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
  const sourceEntries: { path: string; source: Uint8Array }[] = [];
  for (const name of names.toSorted()) {
    const repositoryPath = `${policy.workflowDirectory}/${name}`;
    const file = await safePath(root, repositoryPath, "file");
    const source = await readFile(file);
    sourceEntries.push({ path: repositoryPath, source });
    evidence.push(workflow(repositoryPath, source.toString("utf8")));
  }
  const rootUses = workflowUses(evidence);
  const localCompositeActions = await readLocalCompositeActions(
    root,
    policy.workflowDirectory,
    rootUses
  );
  return Object.freeze({
    workflows: Object.freeze(evidence),
    workflowUses: Object.freeze([...rootUses, ...localCompositeActions.workflowUses]),
    workflowDigest: await workflowDigest([...sourceEntries, ...localCompositeActions.sourceEntries])
  });
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
    const [workflowDirectory, packages] = await Promise.all([
      readWorkflowDirectory(root, policy, signal),
      Promise.all(
        policy.publishablePackageManifests.map((manifestPath) => readPackage(root, manifestPath))
      )
    ]);
    for (const requiredWorkflow of [policy.dependencyReviewWorkflow, policy.sbomWorkflow]) {
      if (!workflowDirectory.workflows.some(({ path }) => path === requiredWorkflow)) {
        inputError(
          "REPOSITORY_SECURITY_REQUIRED_WORKFLOW_UNAVAILABLE",
          `Required security workflow is not discovered: ${requiredWorkflow}.`
        );
      }
    }
    const toolEvidence = await readToolEvidence(root, policy, workflowDirectory.workflowDigest);
    return Object.freeze({
      workflows: workflowDirectory.workflows,
      workflowUses: workflowDirectory.workflowUses,
      workflowDigest: workflowDirectory.workflowDigest,
      packages: Object.freeze(packages),
      toolEvidence: Object.freeze(toolEvidence)
    });
  }
}
