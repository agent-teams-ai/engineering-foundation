import { NodeSha256Digest } from "../adapters/outbound/crypto/node-sha256-digest.js";
import { loadCapabilityConfig, type ProtobufConfigurationDependencies } from "../adapters/inbound/configuration/load-capability-config.js";
import { loadStrictYamlFile } from "../../../features/configuration-input/node.js";
import { FilesystemBufQualificationArtifacts } from "./adapters/outbound/filesystem/filesystem-buf-qualification-artifacts.js";
import { ProcessBufExecutable } from "./adapters/outbound/process/process-buf-executable.js";
import { ProcessBufQualificationRunner } from "./adapters/outbound/process/process-buf-qualification-runner.js";
import {
  qualifyBufBreakingEvidence,
  type QualifyBufBreakingEvidenceResult
} from "./use-cases/qualify-buf-breaking-evidence.js";

export async function qualifyProtobufBreakingEvidence(input: {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly executablePath: string;
  readonly write: boolean;
  readonly signal?: AbortSignal;
}, executor: import("./ports/process-executor.js").BufProcessExecutor, assertSchema: ProtobufConfigurationDependencies["assertSchema"]): Promise<QualifyBufBreakingEvidenceResult> {
  const configuration = await loadCapabilityConfig(
    { readYaml: loadStrictYamlFile, assertSchema },
    input.consumerRoot,
    input.configPath,
    input.signal
  );
  return qualifyBufBreakingEvidence(
    {
      consumerRoot: input.consumerRoot,
      executablePath: input.executablePath,
      configuration,
      write: input.write,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    },
    {
      artifacts: new FilesystemBufQualificationArtifacts(),
      digest: new NodeSha256Digest(),
      runner: new ProcessBufQualificationRunner(new ProcessBufExecutable(executor))
    }
  );
}

export { FilesystemBufQualificationArtifacts } from "./adapters/outbound/filesystem/filesystem-buf-qualification-artifacts.js";
export { ProcessBufExecutable } from "./adapters/outbound/process/process-buf-executable.js";
export { ProcessBufQualificationRunner } from "./adapters/outbound/process/process-buf-qualification-runner.js";
export type {
  BufExecutable,
  BufExecutionResult,
  BufInvocation
} from "./ports/buf-executable.js";
export type {
  BufQualificationArtifacts,
  BufQualificationEvidenceWriteResult
} from "./ports/buf-qualification-artifacts.js";
export type {
  BufQualificationRunner,
  BufQualificationRunInput,
  BufQualificationRunResult
} from "./ports/buf-qualification-runner.js";
export { qualifyBufBreakingEvidence } from "./use-cases/qualify-buf-breaking-evidence.js";
export type { QualifyBufBreakingEvidenceResult } from "./use-cases/qualify-buf-breaking-evidence.js";
export { verifyPinnedBufVersion } from "./use-cases/verify-pinned-buf-version.js";
