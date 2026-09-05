import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { assertNotCancelled } from "../../../../../cancellation.js";
import { CapabilityInputError } from "../../../../validation-reporting/api.js";
import { assertRepositoryRelativePath, ContainedFileReadError } from "../../../../../source-inventory/api.js";
import { configurationFileProblem, MAX_CONFIG_BYTES } from "../../../application/configuration-file-problem.js";
import type { ConfigurationFileReader } from "../../../application/ports/configuration-file-reader.js";
import { parseStrictYamlSource } from "./strict-yaml-parser.js";

function inputError(code: string, message: string, phase: string): never {
  throw new CapabilityInputError({ code, message, phase, retryable: false });
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

export function createStrictYamlFileLoader(reader: ConfigurationFileReader) {
  async function loadStrictYamlFile(
    consumerRoot: string,
    repositoryPath: string,
    phase: string,
    signal?: AbortSignal
  ): Promise<unknown> {
    assertNotCancelled(signal);
    assertRepositoryRelativePath(repositoryPath, phase);
    const root = await resolveConsumerRoot(consumerRoot, phase);
    let bytes: Uint8Array;
    try {
      bytes = await reader.read({
        candidate: resolve(root, repositoryPath),
        maxBytes: MAX_CONFIG_BYTES,
        root
      });
    } catch (error) {
      if (!(error instanceof ContainedFileReadError)) {
        throw error;
      }
      throw new CapabilityInputError(configurationFileProblem(error.failure, repositoryPath, phase));
    }
    const source = Buffer.from(bytes).toString("utf8");
    assertNotCancelled(signal);
    return parseStrictYamlSource(source, phase);
  }
  return loadStrictYamlFile;
}
