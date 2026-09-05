import { resolve } from "node:path";

import { publicApiFileFailure, publicApiInputError } from "../../../application/policies/public-api-evidence-errors.js";
import type { PublicApiFileReader } from "../../../application/ports/public-api-evidence.js";
import { isExactVersion } from "../../../../../semantic-version.js";
import { parseStrictJson } from "@agent-teams/repository-mutation/serialization";

export interface ChangesetsPrereleaseState {
  readonly initialVersion: string;
  readonly tag: string;
}

function invalid(message: string): never {
  publicApiInputError("CHANGESET_PRERELEASE_STATE_INVALID", message, "public-api-evidence");
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

async function readState(root: string, path: string, files: PublicApiFileReader): Promise<Buffer | undefined> {
  try {
    const bytes = await files.read({
      candidate: resolve(root, path),
      maxBytes: 1024 * 1024,
      root
    });
    if (bytes.byteLength > 1024 * 1024) {
      invalid(`Changesets prerelease state is unavailable or changed: ${path}.`);
    }
    return Buffer.from(bytes);
  } catch (error) {
    if (publicApiFileFailure(error) !== undefined && publicApiFileFailure(error) === "missing") {
      return undefined;
    }
    if (publicApiFileFailure(error) !== undefined) {
      invalid(`Changesets prerelease state is unavailable or changed: ${path}.`);
    }
    throw error;
  }
}

export async function readChangesetsPrereleaseState(input: {
  readonly directory: string;
  readonly packageName: string;
  readonly root: string;
}, files: PublicApiFileReader): Promise<Readonly<ChangesetsPrereleaseState> | undefined> {
  const path = `${input.directory}/pre.json`;
  const source = await readState(input.root, path, files);
  if (source === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJson(source.toString("utf8"));
  } catch {
    invalid(`Changesets prerelease state is not strict JSON: ${path}.`);
  }
  const state = record(parsed, "Changesets prerelease state");
  if (state["mode"] !== "pre" && state["mode"] !== "exit") {
    invalid(`Changesets prerelease state has an invalid mode: ${path}.`);
  }
  if (state["mode"] === "exit") {
    return undefined;
  }
  const tag = state["tag"];
  if (typeof tag !== "string" || !/^(?!\d+$)[0-9A-Za-z-]+$/u.test(tag)) {
    invalid(`Changesets prerelease state has an invalid tag: ${path}.`);
  }
  const initialVersions = record(
    state["initialVersions"],
    "Changesets prerelease initialVersions"
  );
  const initialVersion = initialVersions[input.packageName];
  if (typeof initialVersion !== "string" || !isExactVersion(initialVersion)) {
    invalid(`Changesets prerelease state lacks an exact initial version for ${input.packageName}.`);
  }
  return Object.freeze({ initialVersion, tag });
}
