import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { join } from "node:path";

import { isPureModuleTypeScope } from "../../../application/policies/source-package-ownership.js";

interface MarkerObservation {
  readonly path: string;
  readonly bytes?: Buffer;
  readonly identity?: string;
}

function identity(metadata: NonNullable<ReturnType<typeof lstatSync>>): string {
  return [metadata.dev, metadata.ino, metadata.mode, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(":");
}

function readMarker(path: string): MarkerObservation | undefined {
  let descriptor: number | undefined;
  let observedFile = false;
  try {
    const before = lstatSync(path);
    observedFile = true;
    if (!before.isFile() || before.isSymbolicLink() || before.size > 2 * 1024 * 1024) {
      return undefined;
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (identity(fstatSync(descriptor)) !== identity(before)) { return undefined; }
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(descriptor, bytes, count, bytes.length - count, null);
      if (read === 0) { break; }
      count += read;
    }
    if (count !== before.size || identity(fstatSync(descriptor)) !== identity(before) ||
      identity(lstatSync(path)) !== identity(before)) { return undefined; }
    const captured = bytes.subarray(0, count);
    const value: unknown = JSON.parse(captured.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !isPureModuleTypeScope(value as Record<string, unknown>)) { return undefined; }
    return { path, bytes: captured, identity: identity(before) };
  } catch (error) {
    // Absence is valid only when no file was opened or initially observed.
    if (!observedFile && descriptor === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path };
    }
    return undefined;
  } finally {
    if (descriptor !== undefined) { closeSync(descriptor); }
  }
}

/** Only unchanged pure markers can occur between an output owner and its target. */
export class GeneratedOutputManifestObservations {
  readonly #observations: MarkerObservation[] = [];
  #bytes = 0;

  observe(directory: string): boolean {
    if (this.#observations.length >= 5_000) { return false; }
    const observation = readMarker(join(directory, "package.json"));
    if (observation === undefined) { return false; }
    this.#bytes += observation.bytes?.length ?? 0;
    if (this.#bytes > 512 * 1024 * 1024) { return false; }
    this.#observations.push(observation);
    return true;
  }

  stable(): boolean {
    return this.#observations.every((before) => {
      const after = readMarker(before.path);
      return after !== undefined && after.identity === before.identity &&
        (before.bytes === undefined ? after.bytes === undefined :
          after.bytes !== undefined && before.bytes.equals(after.bytes));
    });
  }
}
