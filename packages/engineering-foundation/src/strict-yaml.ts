import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { isAlias, isMap, isNode, isPair, parseDocument, visit } from "yaml";

import { assertNotCancelled } from "./cancellation.js";
import { CapabilityInputError } from "./features/validation-reporting/api.js";
import {
  ContainedFileReadError,
  readContainedRegularFile
} from "./filesystem-path-safety.js";

const MAX_CONFIG_BYTES = 1024 * 1024;

export { assertNotCancelled } from "./cancellation.js";

function inputError(code: string, message: string, phase: string): never {
  throw new CapabilityInputError({ code, message, phase, retryable: false });
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

async function resolveConsumerRoot(consumerRoot: string, phase: string): Promise<string> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(consumerRoot);
    const rootMetadata = await stat(canonicalRoot);
    if (!rootMetadata.isDirectory()) {
      inputError(
        "CONSUMER_ROOT_INVALID",
        "Consumer root must be an existing directory.",
        phase
      );
    }
  } catch (error) {
    if (error instanceof CapabilityInputError) {
      throw error;
    }
    inputError(
      "CONSUMER_ROOT_UNAVAILABLE",
      "Consumer root must be an existing accessible directory.",
      phase
    );
  }
  return canonicalRoot;
}

export function parseStrictYamlSource(source: string, phase: string): unknown {
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
  assertRepositoryRelativePath(repositoryPath, phase);
  const root = await resolveConsumerRoot(consumerRoot, phase);
  let bytes: Buffer;
  try {
    bytes = await readContainedRegularFile({
      candidate: resolve(root, repositoryPath),
      maxBytes: MAX_CONFIG_BYTES,
      root
    });
  } catch (error) {
    if (!(error instanceof ContainedFileReadError)) {
      throw error;
    }
    if (error.failure === "escape") {
      inputError(
        "CONFIG_PATH_ESCAPE",
        `Configuration path escapes the consumer repository: ${repositoryPath}.`,
        phase
      );
    }
    if (error.failure === "invalid") {
      inputError(
        "CONFIG_FILE_INVALID",
        `Configuration file must be a regular file no larger than ${MAX_CONFIG_BYTES} bytes: ${repositoryPath}.`,
        phase
      );
    }
    if (error.failure === "symlink") {
      inputError(
        "CONFIG_SYMLINK_PROHIBITED",
        `Configuration path cannot be a symbolic link: ${repositoryPath}.`,
        phase
      );
    }
    inputError(
      "CONFIG_FILE_UNAVAILABLE",
      `Required configuration file is unavailable or changed while reading: ${repositoryPath}.`,
      phase
    );
  }
  const source = bytes.toString("utf8");
  assertNotCancelled(signal);
  return parseStrictYamlSource(source, phase);
}
