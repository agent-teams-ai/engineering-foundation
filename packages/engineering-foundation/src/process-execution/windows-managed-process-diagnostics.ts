const WINDOWS_WRAPPER_FAILURE_PHASE_PATTERN =
  /(?:^|\r?\n)Windows Job Object runner failed \[phase=(helper-load|bootstrap-request|managed-run)\]:/u;

const WINDOWS_CONTAINMENT_FAILURE_MESSAGES = [
  ["invalid-confirmation", "Windows Job Object wrapper sent an invalid containment confirmation."],
  [
    "wrapper-exited-before-confirmation",
    "Windows Job Object wrapper exited before it confirmed process containment."
  ],
  ["wrapper-confirmation-timeout", "Windows Job Object wrapper did not confirm containment within "],
  ["wrapper-exit-timeout", "Windows Job Object wrapper did not exit within "]
] as const;

const WINDOWS_CONTAINMENT_FILESYSTEM_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EISDIR",
  "ENOENT",
  "EPERM"
]);

function windowsContainmentFailureReason(error: unknown): string {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const candidate = pending.shift();
    if (candidate === undefined || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (candidate instanceof AggregateError) {
      pending.push(...candidate.errors);
    }
    if (candidate instanceof Error) {
      for (const [reason, message] of WINDOWS_CONTAINMENT_FAILURE_MESSAGES) {
        if (candidate.message.startsWith(message)) {
          return reason;
        }
      }
      if (
        "code" in candidate &&
        typeof candidate.code === "string" &&
        WINDOWS_CONTAINMENT_FILESYSTEM_CODES.has(candidate.code)
      ) {
        return `confirmation-read-${candidate.code}`;
      }
      pending.push(candidate.cause);
    }
  }
  return "unknown";
}

export function describeManagedProcessCleanupFailure(
  error: unknown,
  wrapperStderr: readonly Buffer[],
  windows: boolean
): string {
  if (!windows) {
    return "could not clean up its process tree after exit.";
  }
  const stderr = Buffer.concat(wrapperStderr).toString("utf8");
  const wrapperPhase = WINDOWS_WRAPPER_FAILURE_PHASE_PATTERN.exec(stderr)?.[1] ?? "unreported";
  return `could not clean up its process tree after exit. [windows-containment=${windowsContainmentFailureReason(error)};wrapper-phase=${wrapperPhase}]`;
}
