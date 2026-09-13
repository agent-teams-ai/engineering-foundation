import { realpath } from "node:fs/promises";
import type { SourceCensusReader, SourceWorkspaceFileReader } from "../../../api.js";
import { sourceTopologyInputError } from "../../../api.js";
import { RootPackageSourceScopes } from "./root-package-source-scopes.js";
import { discoverSourceWorkspacePaths, sourceWorkspaceDiscoveryLimits } from "./selected-package-source-discovery.js";
import { createSourceWorkspaceFileSystem, revalidateStableRepositoryPath } from "./source-workspace-filesystem.js";

export function createSourceCensusReader(files: SourceWorkspaceFileReader): SourceCensusReader {
  const fileSystem = createSourceWorkspaceFileSystem(files);
  return {
    async read(input) {
      const root = await realpath(input.consumerRoot);
      const manifests = new RootPackageSourceScopes(root, fileSystem, sourceWorkspaceDiscoveryLimits(), input.signal);
      const filePaths = new Set<string>();
      const discovered = await discoverSourceWorkspacePaths(root, {
        repositoryRoots: input.roots,
        recursivePackages: true,
        observeFile: (path) => { filePaths.add(path); },
        budget: manifests.budget,
        observeManifest: (path) => manifests.observe(path),
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
      if (discovered.symbolicLinkPaths.length > 0) {
        sourceTopologyInputError("SOURCE_SYMLINK_PROHIBITED", "Source census encountered a symbolic link.");
      }
      await manifests.revalidate();
      for (const directory of discovered.directorySnapshots) {
        await revalidateStableRepositoryPath(root, directory, fileSystem, input.signal);
      }
      return { sourcePaths: discovered.sourcePaths, filePaths: [...filePaths].toSorted(), manifestPaths: manifests.authorityPaths() };
    }
  };
}
