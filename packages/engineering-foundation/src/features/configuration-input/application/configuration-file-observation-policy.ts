import { assertRepositoryRelativePath, ContainedFileReadError } from "../../../source-inventory/api.js";
import { rejectConfigurationFile } from "./configuration-file-problem.js";

export function assertConfigurationRelativePath(path: string, phase: string): void {
  assertRepositoryRelativePath(path, phase);
}

export function rejectConfigurationObservation(error: unknown, path: string, phase: string): never {
  if (!(error instanceof ContainedFileReadError)) {
    throw error;
  }
  rejectConfigurationFile(error.failure, path, phase);
}
