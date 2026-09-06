import type { SecurityEvidenceObservation } from "../../../application/ports/security-evidence-observation.js";
import { opendir } from "node:fs/promises";

import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import type {
  CompositeActionEvidence,
  RepositorySecurityPolicy,
  WorkflowEvidence,
  WorkflowUseEvidence
} from "../../../application/model/repository-security.js";
import { isSafeLocalWorkflowUse } from "../../../application/model/repository-security.js";
import { digestWorkflowSources } from "./repository-security-digests.js";
import {
  readOptionalEvidenceFile,
  readRequiredEvidenceFile,
  resolveSafeEvidencePath
} from "./repository-security-filesystem.js";
import { assertSecurityObservationActive, repositorySecurityInputError } from "../../../application/policies/repository-security-input.js";
import {
  collectCompositeActionWorkflowUses,
  collectCompositeActionUses,
  collectWorkflowUses,
  parseWorkflow
} from "./workflow-evidence-parser.js";

interface WorkflowDirectoryEvidence {
  readonly compositeActions: readonly CompositeActionEvidence[];
  readonly workflows: readonly WorkflowEvidence[];
  readonly workflowUses: readonly WorkflowUseEvidence[];
  readonly workflowDigest: string;
}

interface LocalCompositeActionEvidence {
  readonly compositeActions: readonly CompositeActionEvidence[];
  readonly sourceEntries: readonly { readonly path: string; readonly source: Uint8Array }[];
  readonly workflowUses: readonly WorkflowUseEvidence[];
}

function isReusableWorkflowUse(use: string, workflowDirectory: string): boolean {
  const repositoryPath = use.slice(2);
  return repositoryPath.startsWith(`${workflowDirectory}/`) && /\.ya?ml$/iu.test(repositoryPath);
}

async function readCompositeActionDescriptor(
  observation: SecurityEvidenceObservation,
  root: string,
  localUse: string
): Promise<{ readonly path: string; readonly source: Uint8Array }> {
  const actionDirectory = localUse.slice(2);
  await resolveSafeEvidencePath(observation, root, actionDirectory);
  const candidates = await Promise.all(
    ["action.yml", "action.yaml"].map(async (name) => {
      const path = `${actionDirectory}/${name}`;
      const source = await readOptionalEvidenceFile(observation, root, path);
      return source === undefined ? undefined : { path, source };
    })
  );
  const descriptors = candidates.flatMap((candidate) =>
    candidate === undefined ? [] : [candidate]
  );
  if (descriptors.length !== 1) {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_LOCAL_ACTION_INVALID",
      `Local action must declare exactly one action.yml or action.yaml descriptor: ${localUse}.`
    );
  }
  const descriptor = descriptors[0];
  if (descriptor === undefined) {
    repositorySecurityInputError(
      "REPOSITORY_SECURITY_LOCAL_ACTION_INVALID",
      `Local action descriptor is unavailable: ${localUse}.`
    );
  }
  return descriptor;
}

async function readLocalCompositeActions(
  observation: SecurityEvidenceObservation,
  root: string,
  workflowDirectory: string,
  rootUses: readonly WorkflowUseEvidence[]
): Promise<LocalCompositeActionEvidence> {
  const pending = rootUses
    .filter(
      ({ uses }) => isSafeLocalWorkflowUse(uses) && !isReusableWorkflowUse(uses, workflowDirectory)
    )
    .toSorted(({ uses: left }, { uses: right }) => compareBinaryStrings(left, right));
  const visited = new Set<string>();
  const compositeActions: CompositeActionEvidence[] = [];
  const sourceEntries: { path: string; source: Uint8Array }[] = [];
  const nestedUses: WorkflowUseEvidence[] = [];
  while (pending.length > 0) {
    const next = pending.shift();
    if (next === undefined || visited.has(next.uses)) {
      continue;
    }
    visited.add(next.uses);
    const descriptor = await readCompositeActionDescriptor(observation, root, next.uses);
    sourceEntries.push(descriptor);
    const discovered = collectCompositeActionUses(observation.parseYaml, descriptor.path, descriptor.source);
    compositeActions.push(discovered);
    const discoveredUses = collectCompositeActionWorkflowUses(discovered);
    nestedUses.push(...discoveredUses);
    for (const candidate of discoveredUses) {
      if (
        isSafeLocalWorkflowUse(candidate.uses) &&
        !isReusableWorkflowUse(candidate.uses, workflowDirectory)
      ) {
        pending.push(candidate);
      }
    }
  }
  return Object.freeze({
    compositeActions: Object.freeze(compositeActions),
    sourceEntries: Object.freeze(sourceEntries),
    workflowUses: Object.freeze(nestedUses)
  });
}

export async function readWorkflowDirectoryEvidence(
  observation: SecurityEvidenceObservation,
  root: string,
  policy: RepositorySecurityPolicy,
  signal?: AbortSignal
): Promise<WorkflowDirectoryEvidence> {
  const directory = await resolveSafeEvidencePath(observation, root, policy.workflowDirectory);
  const names: string[] = [];
  const handle = await opendir(directory);
  for await (const entry of handle) {
    assertSecurityObservationActive(signal);
    if (entry.isSymbolicLink() || !entry.isFile() || !/\.ya?ml$/iu.test(entry.name)) {
      repositorySecurityInputError(
        "REPOSITORY_SECURITY_WORKFLOW_ENTRY_INVALID",
        `Workflow directory contains an unsupported entry: ${entry.name}.`
      );
    }
    names.push(entry.name);
  }
  const workflows: WorkflowEvidence[] = [];
  const sourceEntries: { path: string; source: Uint8Array }[] = [];
  for (const name of names.toSorted()) {
    const repositoryPath = `${policy.workflowDirectory}/${name}`;
    const source = await readRequiredEvidenceFile(observation, root, repositoryPath);
    sourceEntries.push({ path: repositoryPath, source });
    workflows.push(parseWorkflow(observation.parseYaml, repositoryPath, source.toString("utf8")));
  }
  const rootUses = collectWorkflowUses(workflows);
  const localCompositeActions = await readLocalCompositeActions(
    observation,
    root,
    policy.workflowDirectory,
    rootUses
  );
  return Object.freeze({
    compositeActions: localCompositeActions.compositeActions,
    workflows: Object.freeze(workflows),
    workflowUses: Object.freeze([...rootUses, ...localCompositeActions.workflowUses]),
    workflowDigest: await digestWorkflowSources([
      ...sourceEntries,
      ...localCompositeActions.sourceEntries
    ])
  });
}
