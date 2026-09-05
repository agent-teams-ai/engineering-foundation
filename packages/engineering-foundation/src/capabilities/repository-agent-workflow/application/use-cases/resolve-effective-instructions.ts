import { sha256Bytes, sha256Json } from "../../../../canonical-json.js";
import { CapabilityInputError } from "../../../../features/validation-reporting/api.js";
import type {
  EffectiveInstructionCandidateObservation,
  EffectiveInstructionLayerReport,
  EffectiveInstructionsReport
} from "../model/effective-instructions.js";
import {
  DEFAULT_EFFECTIVE_INSTRUCTION_BUDGET_BYTES,
  EFFECTIVE_INSTRUCTION_SEMANTICS
} from "../model/effective-instructions.js";
import type { EffectiveInstructionsReader } from "../ports/effective-instructions-reader.js";

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "repository-agent-workflow-effective-instructions",
    retryable: false
  });
}

function selectedCandidate(
  candidates: readonly EffectiveInstructionCandidateObservation[]
): { readonly candidate: EffectiveInstructionCandidateObservation; readonly index: number } | undefined {
  const index = candidates.findIndex(
    ({ kind }) => kind === "file" || kind === "symlink"
  );
  const candidate = candidates[index];
  return index < 0 || candidate === undefined ? undefined : { candidate, index };
}

function hasInstructionText(bytes: Uint8Array): boolean {
  const text = new TextDecoder("utf-8", {
    fatal: false,
    ignoreBOM: true
  }).decode(bytes);
  return /\P{White_Space}/u.test(text);
}

function scopeFor(directory: string): string {
  return directory === "." ? "**/*" : `${directory}/**/*`;
}

export async function resolveEffectiveInstructions(
  input: {
    readonly consumerRoot: string;
    readonly targetPath: string;
    readonly signal?: AbortSignal;
  },
  reader: EffectiveInstructionsReader
): Promise<EffectiveInstructionsReport> {
  const discovery = await reader.discover(input);
  let remainingBytes = DEFAULT_EFFECTIVE_INSTRUCTION_BUDGET_BYTES;
  let loadedBytes = 0;
  let truncated = false;
  const effectivePaths: string[] = [];
  const digestSources: Array<{
    readonly loadedBytes: number;
    readonly loadedDigest: `sha256:${string}`;
    readonly path: string;
  }> = [];
  const layers: EffectiveInstructionLayerReport[] = [];

  for (const directoryPath of discovery.directories) {
    const directory = await reader.readDirectory({
      consumerRoot: input.consumerRoot,
      directory: directoryPath,
      readSelectedBytes: remainingBytes > 0,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    const selected = selectedCandidate(directory.candidates);
    if (selected === undefined) {
      continue;
    }
    if (selected.candidate.kind === "symlink") {
      inputError(
        "REPOSITORY_AGENT_WORKFLOW_INSTRUCTION_SYMLINK_PROHIBITED",
        `The effective instruction candidate cannot be a symbolic link: ${selected.candidate.path}.`
      );
    }
    if (selected.candidate.kind !== "file") {
      continue;
    }
    if (selected.candidate.bytes === null && remainingBytes > 0) {
      inputError(
        "REPOSITORY_AGENT_WORKFLOW_INSTRUCTION_UNAVAILABLE",
        `The selected instruction candidate was not read: ${selected.candidate.path}.`
      );
    }

    const source = selected.candidate.bytes;
    const admitted = source?.slice(0, remainingBytes) ?? new Uint8Array();
    const instructionTextPresent = source !== null && hasInstructionText(admitted);
    const wasTruncated = source !== null && source.byteLength > admitted.byteLength;
    const canOverrideEarlier = [...effectivePaths];
    let status: EffectiveInstructionLayerReport["status"];
    let appliedBytes: Uint8Array;
    if (remainingBytes === 0) {
      status = "budget-exhausted";
      appliedBytes = new Uint8Array();
    } else if (!instructionTextPresent) {
      status = "ignored-empty";
      appliedBytes = new Uint8Array();
    } else {
      status = wasTruncated ? "truncated" : "applied";
      appliedBytes = admitted;
      remainingBytes -= admitted.byteLength;
      loadedBytes += admitted.byteLength;
      truncated ||= wasTruncated;
      effectivePaths.push(selected.candidate.path);
      digestSources.push({
        path: selected.candidate.path,
        loadedBytes: admitted.byteLength,
        loadedDigest: sha256Bytes(admitted)
      });
    }

    layers.push(Object.freeze({
      order: layers.length + 1,
      directory: directory.directory,
      scope: scopeFor(directory.directory),
      selectedPath: selected.candidate.path,
      selectionReason: "first-regular-candidate",
      applicabilityReason: "instruction-directory-contains-target",
      status,
      sourceBytes: selected.candidate.sourceBytes,
      loadedBytes: appliedBytes.byteLength,
      sourceDigest: source === null ? null : sha256Bytes(source),
      loadedDigest: sha256Bytes(appliedBytes),
      shadowed: Object.freeze(directory.candidates
        .slice(selected.index + 1)
        .filter(({ kind }) => kind === "file" || kind === "symlink")
        .map(({ path }) => Object.freeze({
          path,
          reason: "higher-priority-candidate-selected" as const
        }))),
      canOverrideEarlier: Object.freeze(
        status === "applied" || status === "truncated" ? canOverrideEarlier : []
      )
    }));
  }

  return Object.freeze({
    reportSchemaVersion: 1,
    outcome: "resolved",
    semantics: EFFECTIVE_INSTRUCTION_SEMANTICS,
    target: Object.freeze({
      path: discovery.targetPath,
      directory: discovery.targetDirectory,
      reason: "repository-relative-file-selected-by-caller"
    }),
    budget: Object.freeze({
      maximumBytes: DEFAULT_EFFECTIVE_INSTRUCTION_BUDGET_BYTES,
      loadedBytes,
      exhausted: remainingBytes === 0,
      truncated
    }),
    resolutionDigest: sha256Json({
      semantics: EFFECTIVE_INSTRUCTION_SEMANTICS,
      sources: digestSources,
      targetPath: discovery.targetPath
    }),
    layers: Object.freeze(layers)
  });
}
