import { ContainedFileReadError } from "../../../documentation-observation/api.js";

export interface DocumentFileReadFailure extends Error {
  readonly failure: "changed" | "escape" | "invalid" | "missing" | "symlink" | "unavailable";
}

/** Unknown failures remain unknown; matching fields do not establish provider identity. */
export function isDocumentFileReadFailure(error: unknown): error is DocumentFileReadFailure {
  return error instanceof ContainedFileReadError;
}
