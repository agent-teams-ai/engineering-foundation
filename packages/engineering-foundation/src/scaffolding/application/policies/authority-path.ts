import { assertRepositoryRelativePath } from "../../../source-inventory/api.js";

/** Scaffolding uses the existing repository path admission policy unchanged. */
export function assertScaffoldAuthorityPath(path: string, phase: string): void {
  assertRepositoryRelativePath(path, phase);
}
