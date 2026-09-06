import { isAbsolute } from "node:path";

import { CapabilityInputError } from "../../../features/validation-reporting/api.js";

export function assertRepositoryRelativePath(path: string, phase: string): void {
  const segments = path.split("/");
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new CapabilityInputError({
      code: "CONFIG_PATH_INVALID",
      message: "Configuration paths must be normalized repository-relative POSIX paths.",
      phase,
      retryable: false
    });
  }
}
