import { open, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CapabilityInputError } from "../../../../../../features/validation-reporting/api.js";
import { readContainedRegularFile } from "../../../../../../source-inventory/node.js";
import { assertNotCancelled } from "../../../../../../cancellation.js";
import { bufQualificationInvocationPlan } from "../../../../application/model/buf-breaking-qualification.js";
import type {
  BufQualificationRunner,
  BufQualificationRunInput,
  BufQualificationRunResult
} from "../../../ports/buf-qualification-runner.js";
import type { BufExecutable } from "../../../ports/buf-executable.js";
import { verifyPinnedBufVersion } from "../../../use-cases/verify-pinned-buf-version.js";
import { ProcessBufExecutable } from "./process-buf-executable.js";

const MAX_DESCRIPTOR_BYTES = 64 * 1024 * 1024;

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "protobuf-buf-qualification-process",
    retryable: false
  });
}

async function writePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readBoundedDescriptor(root: string, path: string): Promise<Uint8Array> {
  let descriptor: Uint8Array;
  try {
    descriptor = await readContainedRegularFile({
      candidate: path,
      maxBytes: MAX_DESCRIPTOR_BYTES,
      root
    });
  } catch {
    inputError(
      "BUF_CANDIDATE_DESCRIPTOR_INVALID",
      "Buf candidate descriptor is unavailable, unsafe, or exceeds the supported size limit."
    );
  }
  if (descriptor.length === 0) {
    inputError("BUF_CANDIDATE_DESCRIPTOR_INVALID", "Buf candidate descriptor is empty.");
  }
  return descriptor;
}

export class ProcessBufQualificationRunner implements BufQualificationRunner {
  readonly #executable: BufExecutable;

  constructor(executable: BufExecutable = new ProcessBufExecutable()) {
    this.#executable = executable;
  }

  async run(input: BufQualificationRunInput): Promise<BufQualificationRunResult> {
    assertNotCancelled(input.signal);
    await verifyPinnedBufVersion(
      {
        invocation: {
          executablePath: input.executablePath,
          workingDirectory: input.workingDirectory
        },
        expectedVersion: input.expectedVersion,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      },
      this.#executable
    );
    const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-teams-buf-qualification-"));
    const baselinePath = join(temporaryRoot, "baseline.binpb");
    const candidatePath = join(temporaryRoot, "candidate.binpb");
    const invocation = bufQualificationInvocationPlan({
      baselineDescriptorPath: baselinePath,
      bufConfigPath: input.bufConfigPath,
      candidateDescriptorPath: candidatePath,
      modulePath: input.modulePath
    });
    try {
      await writePrivateFile(baselinePath, input.baselineDescriptorImage);
      const build = await this.#executable.run(
        {
          executablePath: input.executablePath,
          workingDirectory: input.workingDirectory,
          arguments: invocation.buildArguments
        },
        input.signal
      );
      assertNotCancelled(input.signal);
      if (build.exitCode !== 0 || build.stdout.length !== 0 || build.stderr.length !== 0) {
        inputError(
          "BUF_BUILD_FAILED",
          `Buf candidate descriptor build failed or emitted unexpected output: ${build.stderr.trim() || build.stdout.trim() || `exit ${build.exitCode}`}.`
        );
      }
      const candidateDescriptorImage = await readBoundedDescriptor(temporaryRoot, candidatePath);
      const breaking = await this.#executable.run(
        {
          executablePath: input.executablePath,
          workingDirectory: input.workingDirectory,
          arguments: invocation.breakingArguments
        },
        input.signal
      );
      assertNotCancelled(input.signal);
      if ((breaking.exitCode !== 0 && breaking.exitCode !== 100) || breaking.stderr.length !== 0) {
        inputError(
          "BUF_BREAKING_EXECUTION_FAILED",
          `Buf breaking qualification failed: ${breaking.stderr.trim() || `exit ${breaking.exitCode}`}.`
        );
      }
      return Object.freeze({
        status: breaking.exitCode === 0 ? "compatible" : "breaking",
        candidateDescriptorImage,
        rawOutput: breaking.stdout
      });
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }
}
