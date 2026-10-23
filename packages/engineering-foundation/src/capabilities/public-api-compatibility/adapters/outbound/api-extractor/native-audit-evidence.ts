import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";

import { dirname, join, relative, sep } from "node:path";

import {
  auditDigest,
  auditInputPath,
  remapAuditStagePath,
} from "../filesystem/public-api-audit-inputs.js";

import type { ObservationContext } from "./native-audit-context.js";

export function collectMetadataPresence(
  allowed: ReadonlyMap<string, string>,
  configFiles: Map<string, string>,
): Map<string, boolean> {
  // Compiler resolution observes enclosing package metadata. Declare and digest every
  // existing ancestor manifest, including nested and outside-root manifests;
  // record absence for best-effort mutation detection, not an atomic freeze.
  const metadataPresence = new Map<string, boolean>();
  for (const path of allowed.keys()) {
    let directory = dirname(path);
    for (;;) {
      const manifest = join(directory, "package.json");
      if (!metadataPresence.has(manifest)) {
        const present = existsSync(manifest);
        metadataPresence.set(manifest, present);
        if (present) {
          recordMetadataDigest(manifest, allowed, configFiles);
        }
      }
      const parent = dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  }

  return metadataPresence;
}

function recordMetadataDigest(
  manifest: string,
  allowed: ReadonlyMap<string, string>,
  configFiles: Map<string, string>,
): void {
  if (!allowed.has(manifest)) {
    throw new Error(`Undeclared resolution metadata: ${manifest}.`);
  }
  const digest = auditDigest(readFileSync(manifest));
  if (allowed.get(manifest) !== digest) {
    throw new Error(`Undeclared or changed resolution metadata: ${manifest}.`);
  }
  configFiles.set(manifest, digest);
}

export async function revalidateObservationInputs(
  context: ObservationContext,
  metadataPresence: ReadonlyMap<string, boolean>,
  sources: readonly { readonly fileName: string; readonly text: string }[],
): Promise<void> {
  const { input, allowed } = context;
  for (const [path, present] of metadataPresence) {
    if (existsSync(path) !== present) {
      throw new Error("Resolution metadata changed during observation.");
    }
  }
  for (const [path, digest] of allowed) {
    await auditInputPath(
      input.consumerRoot,
      relative(input.consumerRoot, path).split(sep).join("/"),
    );
    if (auditDigest(await readFile(path)) !== digest) {
      throw new Error("Audit input changed during observation.");
    }
  }
  for (const source of sources) {
    if (auditDigest(await readFile(source.fileName)) !== auditDigest(source.text)) {
      throw new Error("Compiler source changed during observation.");
    }
  }
}

export function restoreStagePaths<T>(value: T, stageRoot: string, inputRoot: string): T {
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === "string" ? remapAuditStagePath(entry, stageRoot, inputRoot) : entry,
    ),
  ) as T;
}
