import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { isAlias, isMap, isNode, isPair, parseDocument, visit } from "yaml";

import { CapabilityInputError } from "./capability-runtime.js";

const MAX_CONFIG_BYTES = 1024 * 1024;

function inputError(code: string, message: string, phase: string): never {
  throw new CapabilityInputError({ code, message, phase, retryable: false });
}

export function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CapabilityInputError({
      code: "EXECUTION_CANCELLED",
      message: "Foundation check was cancelled.",
      phase: "execution",
      retryable: false
    });
  }
}

export function assertRepositoryRelativePath(path: string, phase: string): void {
  const segments = path.split("/");
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    inputError(
      "CONFIG_PATH_INVALID",
      "Configuration paths must be normalized repository-relative POSIX paths.",
      phase
    );
  }
}

export async function resolveContainedFile(
  consumerRoot: string,
  repositoryPath: string,
  phase: string
): Promise<string> {
  assertRepositoryRelativePath(repositoryPath, phase);
  const canonicalRoot = await realpath(consumerRoot);
  const candidate = resolve(canonicalRoot, repositoryPath);
  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(candidate);
  } catch {
    inputError(
      "CONFIG_FILE_UNAVAILABLE",
      `Required configuration file is unavailable: ${repositoryPath}.`,
      phase
    );
  }
  const relation = relative(canonicalRoot, canonicalCandidate);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    inputError(
      "CONFIG_PATH_ESCAPE",
      `Configuration path escapes the consumer repository: ${repositoryPath}.`,
      phase
    );
  }
  const metadata = await stat(canonicalCandidate);
  if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) {
    inputError(
      "CONFIG_FILE_INVALID",
      `Configuration file must be a regular file no larger than ${MAX_CONFIG_BYTES} bytes: ${repositoryPath}.`,
      phase
    );
  }
  return canonicalCandidate;
}

export function parseStrictYaml(source: string, phase: string): unknown {
  const document = parseDocument(source, {
    customTags: [],
    merge: false,
    schema: "core",
    uniqueKeys: true
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    const problem = [...document.errors, ...document.warnings]
      .slice(0, 8)
      .map((error) => error.message)
      .join("; ")
      .slice(0, 1000);
    inputError("YAML_INVALID", problem || "YAML input is invalid.", phase);
  }

  let forbidden: string | undefined;
  visit(document, (_key, node) => {
    if (isAlias(node)) {
      forbidden = "YAML aliases are prohibited.";
      return visit.BREAK;
    }
    if (isNode(node) && (node.anchor !== undefined || node.tag !== undefined)) {
      forbidden = "YAML anchors and explicit tags are prohibited.";
      return visit.BREAK;
    }
    if (
      isPair(node) &&
      isNode(node.key) &&
      "value" in node.key &&
      node.key.value === "<<"
    ) {
      forbidden = "YAML merge keys are prohibited.";
      return visit.BREAK;
    }
    if (isMap(node) && node.items.length > 10_000) {
      forbidden = "YAML mapping exceeds the supported size limit.";
      return visit.BREAK;
    }
    return;
  });
  if (forbidden !== undefined) {
    inputError("YAML_FEATURE_PROHIBITED", forbidden, phase);
  }
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}

export async function loadStrictYamlFile(
  consumerRoot: string,
  repositoryPath: string,
  phase: string,
  signal?: AbortSignal
): Promise<unknown> {
  assertNotCancelled(signal);
  const path = await resolveContainedFile(consumerRoot, repositoryPath, phase);
  const source = await readFile(path, "utf8");
  assertNotCancelled(signal);
  return parseStrictYaml(source, phase);
}
