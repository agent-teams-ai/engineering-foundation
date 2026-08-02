import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { pathTraversesSymbolicLink } from "../../../../../filesystem-path-safety.js";
import { assertNotCancelled } from "../../../../../strict-yaml.js";
import type {
  ArchitectureDecisionBaselineReadResult,
  ArchitectureDecisionBaselineRepository
} from "../../../application/ports/architecture-decision-baseline-repository.js";

const MAX_BASELINE_BYTES = 4 * 1024 * 1024;

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

export class FilesystemArchitectureDecisionBaselineRepository
  implements ArchitectureDecisionBaselineRepository
{
  async read(input: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<ArchitectureDecisionBaselineReadResult> {
    assertNotCancelled(input.signal);
    let root: string;
    try {
      root = await realpath(input.consumerRoot);
      if (!(await stat(root)).isDirectory()) {
        return { kind: "unsafe", message: "Consumer root is not a directory." };
      }
    } catch {
      return { kind: "unsafe", message: "Consumer root is not available." };
    }
    const candidate = resolve(root, input.path);
    if (!contained(root, candidate)) {
      return {
        kind: "unsafe",
        message: "Accepted-decision baseline path escapes the consumer repository."
      };
    }
    if (await pathTraversesSymbolicLink(root, candidate)) {
      return {
        kind: "unsafe",
        message: "Accepted-decision baseline path traverses a symbolic link."
      };
    }
    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch {
      return { kind: "missing" };
    }
    if (metadata.isSymbolicLink()) {
      return {
        kind: "unsafe",
        message: "Accepted-decision baseline must not be a symbolic link."
      };
    }
    if (!metadata.isFile() || metadata.size > MAX_BASELINE_BYTES) {
      return {
        kind: "invalid",
        message: `Accepted-decision baseline must be a regular JSON file no larger than ${MAX_BASELINE_BYTES} bytes.`
      };
    }
    try {
      const source = await readFile(candidate, "utf8");
      assertNotCancelled(input.signal);
      return { kind: "valid", value: JSON.parse(source) as unknown };
    } catch {
      return {
        kind: "invalid",
        message: "Accepted-decision baseline is not valid JSON."
      };
    }
  }
}
