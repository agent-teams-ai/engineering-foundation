import { join } from "node:path";

import { assertNotCancelled } from "../../../../../cancellation.js";
import { CapabilityInputError } from "../../../../../features/validation-reporting/api.js";
import { readContainedRegularFile } from "../../../../../filesystem-path-safety.js";
import { parseStrictJson } from "../../../../../strict-json.js";
import type { PackageScriptCatalogReader } from "../../../application/ports/package-script-catalog-reader.js";

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

function inputError(message: string): never {
  throw new CapabilityInputError({
    code: "QUALITY_GATE_RUNNER_PACKAGE_INVALID",
    message,
    phase: "quality-gate-runner-package-catalog",
    retryable: false
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class FilesystemPackageScriptCatalogReader implements PackageScriptCatalogReader {
  async read(consumerRoot: string, signal?: AbortSignal) {
    assertNotCancelled(signal);
    let input: unknown;
    try {
      const source = await readContainedRegularFile({
        root: consumerRoot,
        candidate: join(consumerRoot, "package.json"),
        maxBytes: MAX_PACKAGE_JSON_BYTES
      });
      input = parseStrictJson(source.toString("utf8"));
    } catch (error) {
      inputError(
        `The consumer root package.json must be a stable strict JSON file: ${
          error instanceof Error ? error.message : "unavailable"
        }`
      );
    }
    assertNotCancelled(signal);
    if (!isRecord(input)) {
      inputError("The consumer root package.json must be an object.");
    }
    const scriptsInput = input["scripts"];
    if (!isRecord(scriptsInput)) {
      inputError("The consumer root package.json must declare a scripts object.");
    }
    const scripts: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [id, command] of Object.entries(scriptsInput)) {
      if (typeof command !== "string") {
        inputError(`package.json script ${id} must be a string.`);
      }
      scripts[id] = command;
    }
    return Object.freeze({ scripts: Object.freeze(scripts) });
  }
}
