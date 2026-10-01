import { realpath } from "node:fs/promises";
import { posix } from "node:path";
import type { SourceCensusReader, SourceWorkspaceFileReader } from "../../../api.js";
import { sourceTopologyInputError } from "../../../api.js";
import { RootPackageSourceScopes } from "./root-package-source-scopes.js";
import { discoverSourceWorkspacePaths, sourceWorkspaceDiscoveryLimits } from "./selected-package-source-discovery.js";
import { createSourceWorkspaceFileSystem, revalidateStableRepositoryPath } from "./source-workspace-filesystem.js";
import { inspectUniqueRoots, revalidateRoots } from "./source-workspace-root-snapshot.js";

export function createSourceCensusReader(files: SourceWorkspaceFileReader): SourceCensusReader {
  const fileSystem = createSourceWorkspaceFileSystem(files);
  return {
    async read(input) {
      const root = await realpath(input.consumerRoot);
      const manifests = new RootPackageSourceScopes(root, fileSystem, sourceWorkspaceDiscoveryLimits(), input.signal);
      const scopes = await inspectUniqueRoots({
        canonicalConsumerRoot: root, roots: [...new Set(input.roots)], expectedKind: "source",
        operations: fileSystem, label: "Source census roots",
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
      const directories = [...new Set(scopes.map(({ repositoryPath, canonicalMetadata }) =>
        canonicalMetadata.isDirectory() ? repositoryPath : posix.dirname(repositoryPath)))];
      const filePaths = new Set<string>();
      const discovered = await discoverSourceWorkspacePaths(root, {
        // Start each traversal once. Exact file scopes reopen generated ancestors
        // through the existing discovery mechanism, without narrowing the census.
        repositoryRoots: directories.filter((path) => !directories.some((other) =>
          other !== path && (other === "." || path.startsWith(`${other}/`)))),
        governedRoots: input.roots.filter((path) => path !== "."),
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
      await revalidateRoots({ canonicalConsumerRoot: root, roots: scopes, operations: fileSystem,
        ...(input.signal === undefined ? {} : { signal: input.signal }) });
      for (const directory of discovered.directorySnapshots) {
        await revalidateStableRepositoryPath(root, directory, fileSystem, input.signal);
      }
      return { sourcePaths: discovered.sourcePaths, filePaths: [...filePaths].toSorted(), manifestPaths: manifests.authorityPaths() };
    }
  };
}
