import { fileURLToPath } from "node:url";
import { assertExplicitSourceGitAuthority } from "../../tools/profile-root.mts";

export async function repositorySourceRoot(): Promise<string> {
  const source =
    process.env["AGENT_TEAMS_FOUNDATION_SOURCE_ROOT"] ??
    fileURLToPath(new URL("../..", import.meta.url));
  return (await assertExplicitSourceGitAuthority(source)).sourceRoot;
}
