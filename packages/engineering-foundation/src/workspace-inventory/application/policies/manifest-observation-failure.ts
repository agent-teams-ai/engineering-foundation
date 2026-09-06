import { ContainedFileReadError } from "../../../source-inventory/api.js";
import { manifestUnstable } from "./workspace-input-failures.js";

export function rejectManifestObservation(error: unknown, manifestPath: string): never {
  if (!(error instanceof SyntaxError) && !(error instanceof ContainedFileReadError)) {
    throw error;
  }
  manifestUnstable(manifestPath);
}
