import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import { DocsProfileError } from "../domain/profile-policy.js";

export const PORTABLE_DOCS_PROFILE_PATH = "docs.config.yaml";
export const LEGACY_AGENT_TEAMS_PROFILE_PATH = "architecture/foundation/docs-protocol.yaml";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {return false;}
    throw error;
  }
}

export async function discoverDocsProfilePath(input: {
  readonly consumerRoot: string;
  readonly explicitProfilePath?: string;
}): Promise<string> {
  if (input.explicitProfilePath !== undefined) {return input.explicitProfilePath;}
  const root = resolve(input.consumerRoot);
  const [portable, legacy] = await Promise.all([
    exists(resolve(root, PORTABLE_DOCS_PROFILE_PATH)),
    exists(resolve(root, LEGACY_AGENT_TEAMS_PROFILE_PATH))
  ]);
  if (portable && legacy) {
    throw new DocsProfileError(
      `Both ${PORTABLE_DOCS_PROFILE_PATH} and ${LEGACY_AGENT_TEAMS_PROFILE_PATH} exist; select one explicitly with --profile.`
    );
  }
  if (portable) {return PORTABLE_DOCS_PROFILE_PATH;}
  if (legacy) {return LEGACY_AGENT_TEAMS_PROFILE_PATH;}
  return PORTABLE_DOCS_PROFILE_PATH;
}
