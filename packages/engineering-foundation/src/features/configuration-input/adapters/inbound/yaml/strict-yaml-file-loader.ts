import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { assertRepositoryRelativePath, ContainedFileReadError } from "../../../../../source-inventory/api.js";
import {
  assertConfigurationReadActive,
  rejectConfigurationRoot,
  rejectNonDirectoryConfigurationRoot,
  rejectConfigurationFile,
  MAX_CONFIG_BYTES
} from "../../../application/configuration-file-problem.js";
import type { ConfigurationFileReader } from "../../../application/ports/configuration-file-reader.js";
import { parseStrictYamlSource } from "./strict-yaml-parser.js";

async function resolveConsumerRoot(consumerRoot: string, phase: string): Promise<string> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(consumerRoot);
    const rootMetadata = await stat(canonicalRoot);
    if (!rootMetadata.isDirectory()) {
      rejectNonDirectoryConfigurationRoot(phase);
    }
  } catch (error) {
    rejectConfigurationRoot(error, phase);
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
    assertConfigurationReadActive(signal);
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
      rejectConfigurationFile(error.failure, repositoryPath, phase);
    }
    const source = Buffer.from(bytes).toString("utf8");
    assertConfigurationReadActive(signal);
    return parseStrictYamlSource(source, phase);
  }
  return loadStrictYamlFile;
}
