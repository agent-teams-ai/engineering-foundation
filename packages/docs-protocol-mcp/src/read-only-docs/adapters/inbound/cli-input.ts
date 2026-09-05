import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { docsProfilePath, validatePortableRepositoryPath } from "@agent-teams/docs-protocol";

import type { DocsBinding } from "../../application/ports/docs-reader.js";

export class CliInputError extends Error {
  override readonly name = "CliInputError";
}

function optionValue(arguments_: readonly string[], index: number, name: string): Readonly<{ consumed: number; value: string }> | undefined {
  const argument = arguments_[index];
  if (argument === name) {
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {throw new CliInputError(`${name} requires a value.`);}
    return Object.freeze({ consumed: 2, value });
  }
  const prefix = `${name}=`;
  return argument?.startsWith(prefix) === true
    ? Object.freeze({ consumed: 1, value: argument.slice(prefix.length) })
    : undefined;
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function parseOptions(arguments_: readonly string[]): Readonly<{ consumerRoot: string; profilePath?: string }> {
  let consumerRoot: string | undefined;
  let profilePath: string | undefined;
  for (let index = 0; index < arguments_.length;) {
    const root = optionValue(arguments_, index, "--consumer-root");
    const profile = optionValue(arguments_, index, "--profile");
    if (root !== undefined) {
      if (consumerRoot !== undefined) {throw new CliInputError("--consumer-root may be specified only once.");}
      consumerRoot = root.value;
      index += root.consumed;
    } else if (profile !== undefined) {
      if (profilePath !== undefined) {throw new CliInputError("--profile may be specified only once.");}
      profilePath = profile.value;
      index += profile.consumed;
    } else {
      throw new CliInputError("Unknown startup argument.");
    }
  }
  if (consumerRoot === undefined || consumerRoot.length === 0) {throw new CliInputError("--consumer-root is required.");}
  if (profilePath !== undefined) {
    try {
      validatePortableRepositoryPath(profilePath, "--profile");
    } catch {
      throw new CliInputError("--profile must be a portable repository-relative path.");
    }
  }
  return Object.freeze({ consumerRoot, ...(profilePath === undefined ? {} : { profilePath }) });
}

export async function parseStartupArguments(arguments_: readonly string[], cwd: string): Promise<DocsBinding> {
  const options = parseOptions(arguments_);

  const canonicalRoot = await realpath(resolve(cwd, options.consumerRoot)).catch(() => {
    throw new CliInputError("--consumer-root must identify an existing directory.");
  });
  const rootState = await stat(canonicalRoot).catch(() => null);
  if (rootState?.isDirectory() !== true) {throw new CliInputError("--consumer-root must identify an existing directory.");}
  if (options.profilePath !== undefined && !contained(canonicalRoot, resolve(canonicalRoot, options.profilePath))) {
    throw new CliInputError("--profile must stay within the consumer root.");
  }
  let profilePath: string;
  try {
    profilePath = await docsProfilePath({
      consumerRoot: canonicalRoot,
      ...(options.profilePath === undefined
        ? {}
        : { explicitProfilePath: options.profilePath })
    });
  } catch {
    throw new CliInputError("Documentation profile discovery is ambiguous; pass --profile explicitly.");
  }
  const profile = resolve(canonicalRoot, profilePath);
  const profileState = await lstat(profile).catch(() => null);
  const canonicalProfile = await realpath(profile).catch(() => null);
  if (
    profileState?.isFile() !== true || profileState.isSymbolicLink() ||
    canonicalProfile === null || !contained(canonicalRoot, canonicalProfile)
  ) {
    if (options.profilePath === undefined && profileState === null) {
      throw new CliInputError("No documentation profile was discovered; pass --profile explicitly.");
    }
    throw new CliInputError("The selected documentation profile must be one real contained file.");
  }
  return Object.freeze({ consumerRoot: canonicalRoot, profilePath });
}
