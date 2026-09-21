import type { GrowthAuthorityMetadataRoot } from "../../../application/model/growth-authority.js";
import type { GrowthCancellation } from "../../../application/model/growth-observation.js";
import { GrowthObservationInvariantError } from "../../../application/model/growth-observation.js";
import type { PublicApiFileReader } from "../../../application/ports/public-api-evidence.js";
import { readGrowthInputFile } from "./growth-invocation.js";

/** Qualify consumer-owned source evidence against committed regular files and
 * the actual working bytes. No metadata record can authenticate itself. */
export async function assertGrowthMetadataRootSources(roots: readonly GrowthAuthorityMetadataRoot[], consumerRoot: string,
  dependencies: { readonly files: PublicApiFileReader;
    readonly runGit: (args: readonly string[], signal?: AbortSignal) => Promise<{ readonly exitCode: number; readonly stdout: string }> },
  cancellation: GrowthCancellation): Promise<void> {
  const git = async (args: readonly string[]): Promise<string> => {
    cancellation.throwIfCancelled();
    const result = await dependencies.runGit(args, cancellation.signal);
    if (result.exitCode !== 0) { throw new GrowthObservationInvariantError("growth-metadata-root-source-unavailable"); }
    return result.stdout;
  };
  for (const root of roots) {
    for (const side of ["base", "candidate"] as const) {
      const evidence = root.evidence[side];
      if ((await git(["rev-parse", `${evidence.source.commit}^{tree}`])).trim() !== evidence.source.tree) {
        throw new GrowthObservationInvariantError("growth-metadata-root-source-mismatch");
      }
      const inputs = [[root.evidence.manifestPath, evidence.manifestBytes],
        ["pnpm-workspace.yaml", evidence.workspaceBytes], [root.evidence.classificationPath, evidence.classificationBytes]] as const;
      for (const [path, expected] of inputs) {
        const mode = await git(["ls-tree", evidence.source.commit, "--", path]);
        if (!/^100(?:644|755) blob [a-f0-9]{40}\t/u.test(mode)
          || await git(["show", `${evidence.source.commit}:${path}`]) !== expected) {
          throw new GrowthObservationInvariantError("growth-metadata-root-source-bytes-mismatch");
        }
        const actual = side === "candidate"
          ? new TextDecoder("utf-8", { fatal: true }).decode(await readGrowthInputFile(consumerRoot, path, dependencies.files)) : expected;
        if (actual !== expected) {
          throw new GrowthObservationInvariantError("growth-metadata-root-working-bytes-mismatch");
        }
      }
    }
  }
  cancellation.throwIfCancelled();
}
