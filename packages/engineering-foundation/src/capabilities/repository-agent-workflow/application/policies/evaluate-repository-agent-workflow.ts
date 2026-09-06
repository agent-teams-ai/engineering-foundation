import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import type { FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";
import type {
  InstructionFileEvidence,
  RepositoryAgentWorkflowEvidence,
  RepositoryAgentWorkflowPolicy
} from "../model/repository-agent-workflow.js";

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
    requiresArchitectureReview: false
  });
}

function fileSource(evidence: InstructionFileEvidence): string | null {
  return evidence.kind === "file" ? evidence.source : null;
}

function isExactAdapter(source: string, candidates: readonly string[]): boolean {
  return candidates.includes(source.trim());
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
    ...canonicalSegments.slice(commonSegments)
  ].join("/");
  const normalized = relative.startsWith(".") ? relative : `./${relative}`;
  return Object.freeze([`@${relative}`, `@${normalized}`]);
}

function validateInstructionFiles(
  policy: RepositoryAgentWorkflowPolicy,
  evidence: RepositoryAgentWorkflowEvidence
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
          remediation: "Create a regular instruction file within the repository."
        })
      );
    }
  }
  return diagnostics;
}

function validateAdapters(
  policy: RepositoryAgentWorkflowPolicy,
  evidence: RepositoryAgentWorkflowEvidence
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
          evidence: candidates.map((value) => ({ kind: "accepted-import", value }))
        })
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
        remediation: `Require Copilot to read and follow ${policy.instructions.canonical}.`
      })
    );
  }
  return diagnostics;
}

function validateCommands(
  policy: RepositoryAgentWorkflowPolicy,
  evidence: RepositoryAgentWorkflowEvidence
): FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  const canonicalSource = fileSource(evidence.instructionFiles.canonical);
  const requiredScripts = new Set([
    policy.scripts.changed,
    policy.scripts.fast,
    policy.scripts.full,
    ...policy.changedChecks.map(({ script }) => script)
  ]);
  for (const script of [...requiredScripts].toSorted()) {
    if (!(script in evidence.packageScripts)) {
      diagnostics.push(
        diagnostic({
          ruleId: "repository.agent-workflow.package-script-missing",
          subject: `package-script:${script}`,
          message: `Required package script is missing: ${script}.`,
          path: "package.json",
          remediation: `Define the ${script} package script.`
        })
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
          remediation: `Document when agents must run pnpm ${script}.`
        })
      );
    }
  }
  const changedCommand = evidence.packageScripts[policy.scripts.changed];
  const installedRunner =
    /^(?:pnpm\s+build\s*&&\s*)?agent-teams-foundation\s+agent-workflow\s+changed\s+--consumer\s+\.$/u;
  const selfDogfoodRunner =
    /^pnpm\s+build\s*&&\s*node\s+packages\/engineering-foundation\/dist\/cli\.js\s+agent-workflow\s+changed\s+--consumer\s+\.$/u;
  if (
    changedCommand !== undefined &&
    !installedRunner.test(changedCommand.trim()) &&
    !selfDogfoodRunner.test(changedCommand.trim())
  ) {
    diagnostics.push(
      diagnostic({
        ruleId: "repository.agent-workflow.changed-runner-invalid",
        subject: `package-script:${policy.scripts.changed}`,
        message: "The changed-file script bypasses the shared Foundation runner.",
        path: "package.json",
        remediation: "Route the script to the installed CLI or Foundation's exact built self-dogfood entrypoint."
      })
    );
  }
  return diagnostics;
}

export function evaluateRepositoryAgentWorkflow(
  policy: RepositoryAgentWorkflowPolicy,
  evidence: RepositoryAgentWorkflowEvidence
): readonly FoundationDiagnostic[] {
  return Object.freeze([
    ...validateInstructionFiles(policy, evidence),
    ...validateAdapters(policy, evidence),
    ...validateCommands(policy, evidence)
  ].toSorted((left, right) =>
    compareBinaryStrings(
      `${left.ruleId}:${left.subject}`,
      `${right.ruleId}:${right.subject}`
    )
  ));
}
