import { CapabilityInputError } from "../../../../features/validation-reporting/api.js";
import { assertNotCancelled } from "../../../../cancellation.js";
import type { BufExecutable, BufInvocation } from "../ports/buf-executable.js";

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true;
    }
  }
  return false;
}

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "protobuf-buf-executable",
    retryable: false
  });
}

export async function verifyPinnedBufVersion(
  input: {
    readonly invocation: Omit<BufInvocation, "arguments">;
    readonly expectedVersion: string;
    readonly signal?: AbortSignal;
  },
  executable: BufExecutable
): Promise<void> {
  assertNotCancelled(input.signal);
  if (
    typeof input.expectedVersion !== "string" ||
    input.expectedVersion.length === 0 ||
    input.expectedVersion.length > 80 ||
    hasControlCharacter(input.expectedVersion)
  ) {
    inputError("BUF_VERSION_EXPECTATION_INVALID", "Expected Buf version is invalid.");
  }
  const result = await executable.run(
    {
      ...input.invocation,
      arguments: ["--version"]
    },
    input.signal
  );
  assertNotCancelled(input.signal);
  if (result.exitCode !== 0) {
    inputError(
      "BUF_VERSION_FAILED",
      `Pinned Buf executable could not report its version: ${result.stderr.trim() || "unknown error"}.`
    );
  }
  const reportedVersion = result.stdout.trim();
  if (reportedVersion !== input.expectedVersion) {
    inputError(
      "BUF_VERSION_MISMATCH",
      `Pinned Buf version ${reportedVersion || "missing"} does not match expected ${input.expectedVersion}.`
    );
  }
}
