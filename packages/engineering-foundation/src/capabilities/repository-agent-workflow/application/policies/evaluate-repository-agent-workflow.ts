import { parseStaticHostCommand } from "../../../../features/configuration-input/application/static-host-command.js";
import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import type { FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";
import type {
  InstructionFileEvidence,
  RepositoryAgentWorkflowEvidence,
  RepositoryAgentWorkflowPolicy,
} from "../model/repository-agent-workflow.js";
import type { WorkflowCoveragePolicy } from "../model/check-changed.js";

function diagnostic(input: {
  readonly ruleId: string;
  readonly subject: string;
  readonly message: string;
  readonly path: string;
  readonly remediation: string;
  readonly evidence?: readonly { readonly kind: string; readonly value: string }[];
}): FoundationDiagnostic {
  return Object.freeze({
    ruleId: input.ruleId,
    severity: "error",
    subject: input.subject,
    message: input.message,
    location: { path: input.path },
    relatedLocations: [],
    evidence: input.evidence ?? [],
    remediation: input.remediation,
    requiresArchitectureReview: false,
  });
}

function fileSource(evidence: InstructionFileEvidence): string | null {
  return evidence.kind === "file" ? evidence.source : null;
}

function isExactAdapter(source: string, candidates: readonly string[]): boolean {
  return candidates.includes(source.trim());
}

// Recognize the declaration only; Host code and runtime qualification are separate.
function isStaticHostToolRunner(command: string, successor: boolean): boolean {
  const host = parseStaticHostCommand(command);
  return (
    host !== undefined &&
    host.arguments.length === 6 &&
    host.arguments[0] === "tool" &&
    host.arguments[1] === "agent-teams-foundation" &&
    host.arguments[2] === "agent-workflow" &&
    host.arguments[3] === (successor ? "check-changed" : "changed") &&
    host.arguments[4] === "--consumer" &&
    host.arguments[5] === "."
  );
}

function importCandidates(adapterPath: string, canonicalPath: string): readonly string[] {
  const adapterDirectory = adapterPath.split("/").slice(0, -1);
  const canonicalSegments = canonicalPath.split("/");
  let commonSegments = 0;
  while (
    adapterDirectory[commonSegments] !== undefined &&
    adapterDirectory[commonSegments] === canonicalSegments[commonSegments]
  ) {
    commonSegments += 1;
  }
  const relative = [
    ...adapterDirectory.slice(commonSegments).map(() => ".."),
    ...canonicalSegments.slice(commonSegments),
  ].join("/");
  const normalized = relative.startsWith(".") ? relative : `./${relative}`;
  return Object.freeze([`@${relative}`, `@${normalized}`]);
}

function validateInstructionFiles(
  policy: RepositoryAgentWorkflowPolicy,
  evidence: RepositoryAgentWorkflowEvidence,
): FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  for (const kind of ["canonical", "claude", "gemini", "copilot"] as const) {
    const repositoryPath = policy.instructions[kind];
    const file = evidence.instructionFiles[kind];
    if (file.kind !== "file") {
      diagnostics.push(
        diagnostic({
          ruleId: "repository.agent-workflow.instruction-file-invalid",
          subject: `${kind}:${repositoryPath}`,
          message: `Instruction file is ${file.kind}: ${repositoryPath}.`,
          path: repositoryPath,
          remediation: "Create a regular instruction file within the repository.",
        }),
      );
    }
  }
  return diagnostics;
}

function validateAdapters(
  policy: RepositoryAgentWorkflowPolicy,
  evidence: RepositoryAgentWorkflowEvidence,
): FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  for (const kind of ["claude", "gemini"] as const) {
    const source = fileSource(evidence.instructionFiles[kind]);
    const candidates = importCandidates(policy.instructions[kind], policy.instructions.canonical);
    if (source !== null && !isExactAdapter(source, candidates)) {
      diagnostics.push(
        diagnostic({
          ruleId: "repository.agent-workflow.adapter-not-linked",
          subject: `${kind}:${policy.instructions[kind]}`,
          message: `${kind} instructions do not import ${policy.instructions.canonical}.`,
          path: policy.instructions[kind],
          remediation: `Replace the adapter content with ${candidates[0]}.`,
          evidence: candidates.map((value) => ({ kind: "accepted-import", value })),
        }),
      );
    }
  }
  const copilotSource = fileSource(evidence.instructionFiles.copilot);
  if (copilotSource !== null && !copilotSource.includes(policy.instructions.canonical)) {
    diagnostics.push(
      diagnostic({
        ruleId: "repository.agent-workflow.adapter-not-linked",
        subject: `copilot:${policy.instructions.copilot}`,
        message: `Copilot instructions do not reference ${policy.instructions.canonical}.`,
        path: policy.instructions.copilot,
        remediation: `Require Copilot to read and follow ${policy.instructions.canonical}.`,
      }),
    );
  }
  return diagnostics;
}

function validateCommands(
  policy: RepositoryAgentWorkflowPolicy,
  evidence: RepositoryAgentWorkflowEvidence,
  successor = false,
): FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  const canonicalSource = fileSource(evidence.instructionFiles.canonical);
  const requiredScripts = new Set([
    policy.scripts.changed,
    policy.scripts.fast,
    policy.scripts.full,
    ...policy.changedChecks.map(({ script }) => script),
  ]);
  for (const script of [...requiredScripts].toSorted()) {
    if (!(script in evidence.packageScripts)) {
      diagnostics.push(
        diagnostic({
          ruleId: "repository.agent-workflow.package-script-missing",
          subject: `package-script:${script}`,
          message: `Required package script is missing: ${script}.`,
          path: "package.json",
          remediation: `Define the ${script} package script.`,
        }),
      );
    }
  }
  for (const script of [policy.scripts.changed, policy.scripts.fast, policy.scripts.full]) {
    if (canonicalSource !== null && !canonicalSource.includes(script)) {
      diagnostics.push(
        diagnostic({
          ruleId: "repository.agent-workflow.command-not-documented",
          subject: `instruction-command:${script}`,
          message: `Canonical instructions do not mention ${script}.`,
          path: policy.instructions.canonical,
          remediation: `Document when agents must run ${policy.packageManager} run ${script}.`,
        }),
      );
    }
  }
  const changedCommand = evidence.packageScripts[policy.scripts.changed];
  const installedRunner =
    /^(?:pnpm\s+build\s*&&\s*)?agent-teams-foundation\s+agent-workflow\s+changed\s+--consumer\s+\.$/u;
  const selfDogfoodRunner =
    /^pnpm\s+build\s*&&\s*node\s+packages\/engineering-foundation\/dist\/cli\.js\s+agent-workflow\s+changed\s+--consumer\s+\.$/u;
  const successorRunner =
    /^(?:pnpm\s+build\s*&&\s*)?agent-teams-foundation\s+agent-workflow\s+check-changed\s+--consumer\s+\.$/u;
  const successorDogfood =
    /^pnpm\s+build\s*&&\s*node\s+packages\/engineering-foundation\/dist\/cli\.js\s+agent-workflow\s+check-changed\s+--consumer\s+\.$/u;
  const repositoryCommandRunner =
    /^node\s+tools\/repository-command\.mts\s+script\s+build\s*&&\s*node\s+tools\/repository-command\.mts\s+tool\s+check:changed$/u;
  if (
    changedCommand !== undefined &&
    !isStaticHostToolRunner(changedCommand, successor) &&
    !(successor
      ? successorRunner.test(changedCommand.trim()) ||
        successorDogfood.test(changedCommand.trim()) ||
        repositoryCommandRunner.test(changedCommand.trim())
      : installedRunner.test(changedCommand.trim()) ||
        selfDogfoodRunner.test(changedCommand.trim()) ||
        repositoryCommandRunner.test(changedCommand.trim()))
  ) {
    diagnostics.push(
      diagnostic({
        ruleId: "repository.agent-workflow.changed-runner-invalid",
        subject: `package-script:${policy.scripts.changed}`,
        message: "The changed-file script bypasses the shared Foundation runner.",
        path: "package.json",
        remediation:
          "Route the script to the installed CLI or Foundation's exact built self-dogfood entrypoint.",
      }),
    );
  }
  return diagnostics;
}

/** Compatibility projection is only for instruction/package-script conformance.
 * It never relabels v1 changed execution or constructs a v2 coverage result. */
export function workflowV2ConformancePolicy(
  policy: WorkflowCoveragePolicy,
): RepositoryAgentWorkflowPolicy {
  const scripts = [
    ...new Set(policy.checks.flatMap((check) => [check.script, ...check.prerequisites])),
  ];
  return {
    packageManager: policy.packageManager,
    instructions: policy.instructions,
    scripts: policy.scripts,
    changedChecks: scripts.map((script, index) => ({
      id: `v2-conformance-${index}`,
      script,
      extensions: [],
      passPaths: false,
    })),
    fullScanPaths: [],
  };
}

export function evaluateRepositoryAgentWorkflowV2(
  policy: WorkflowCoveragePolicy,
  evidence: RepositoryAgentWorkflowEvidence,
): readonly FoundationDiagnostic[] {
  const compatibility = workflowV2ConformancePolicy(policy);
  return Object.freeze(
    [
      ...validateInstructionFiles(compatibility, evidence),
      ...validateAdapters(compatibility, evidence),
      ...validateCommands(compatibility, evidence, true),
    ].toSorted((left, right) =>
      compareBinaryStrings(`${left.ruleId}:${left.subject}`, `${right.ruleId}:${right.subject}`),
    ),
  );
}

export function evaluateRepositoryAgentWorkflow(
  policy: RepositoryAgentWorkflowPolicy,
  evidence: RepositoryAgentWorkflowEvidence,
): readonly FoundationDiagnostic[] {
  return Object.freeze(
    [
      ...validateInstructionFiles(policy, evidence),
      ...validateAdapters(policy, evidence),
      ...validateCommands(policy, evidence),
    ].toSorted((left, right) =>
      compareBinaryStrings(`${left.ruleId}:${left.subject}`, `${right.ruleId}:${right.subject}`),
    ),
  );
}
