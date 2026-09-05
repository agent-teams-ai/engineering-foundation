import { resolve } from "node:path";

import { CapabilityInputError } from "../../../../../features/validation-reporting/api.js";
import { ContainedFileReadError } from "../../../../../source-inventory/api.js";
import { readContainedRegularFile } from "../../../../../source-inventory/node.js";
import { isExactVersion } from "../../../../../semantic-version.js";
import { parseStrictJson } from "@agent-teams/repository-mutation/serialization";

export interface ChangesetsPrereleaseState {
  readonly initialVersion: string;
  readonly tag: string;
}

function invalid(message: string): never {
  throw new CapabilityInputError({
    code: "CHANGESET_PRERELEASE_STATE_INVALID",
    message,
    phase: "public-api-evidence",
    retryable: false
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

async function readState(root: string, path: string): Promise<Buffer | undefined> {
  try {
    return await readContainedRegularFile({
      candidate: resolve(root, path),
      maxBytes: 1024 * 1024,
      root
    });
  } catch (error) {
    if (error instanceof ContainedFileReadError && error.failure === "missing") {
      return undefined;
    }
    if (error instanceof ContainedFileReadError) {
      invalid(`Changesets prerelease state is unavailable or changed: ${path}.`);
    }
    throw error;
  }
}

export async function readChangesetsPrereleaseState(input: {
  readonly directory: string;
  readonly packageName: string;
  readonly root: string;
}): Promise<Readonly<ChangesetsPrereleaseState> | undefined> {
  const path = `${input.directory}/pre.json`;
  const source = await readState(input.root, path);
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
