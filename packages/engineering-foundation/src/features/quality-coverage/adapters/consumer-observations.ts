import { normalize, relative, resolve, sep } from "node:path";
import {
  assertNotCancelled, classifyQualityCensus, executesScript, qualitySourceLanguage,
  type QualityCoverageObservation, type QualityCoverageReader,
  type QualityObservationPorts, type QualityFileReader
} from "../api.js";
import { inspectProtectedConfig } from "./protected-config.js";
import { invalidQualityInput, mapQualityProfile, mapQualityTopology, qualityRecord, qualityString } from "./profile-input.js";

export interface QualityConfigurationReader {
  read(consumerRoot: string, path: string, phase: string, signal?: AbortSignal): Promise<unknown>;
  assertProfile(value: unknown): Promise<void>;
}

function scriptsFrom(value: unknown): Readonly<Record<string, string>> {
  const scripts = qualityRecord(qualityRecord(value)["scripts"]);
  return Object.fromEntries(Object.entries(scripts).map(([name, command]) => [name, qualityString(command)]));
}

function nativeScriptPath(command: string | undefined): string | undefined {
  const path = /^node (scripts\/[\w./-]+\.mjs)$/u.exec(command ?? "")?.[1];
  return path === undefined ? undefined : normalize(path).split(sep).join("/");
}

function requiredRoute(
  scripts: Readonly<Record<string, string>>, entry: string, target: string, scopeOnly: boolean
): boolean {
  const suffix = ` quality check --consumer .${scopeOnly ? " --scope-only" : ""}`;
  return ["agent-teams-foundation", "node packages/engineering-foundation/dist/cli.js"].some((host) =>
    executesScript(scripts, entry, target, `${host}${suffix}`)
  );
}

/** The same static observation is used by aggregate checks and explicit execution. */
export function createQualityCoverageReader(
  ports: QualityObservationPorts, configuration: QualityConfigurationReader, readFile: QualityFileReader
): QualityCoverageReader {
  return {
    async read(consumerRoot, configPath, signal): Promise<QualityCoverageObservation> {
      assertNotCancelled(signal);
      const value = await configuration.read(consumerRoot, configPath, "quality-profile", signal);
      await configuration.assertProfile(value);
      const profile = mapQualityProfile(value);
      for (const project of profile.compilerProjects) {
        try { await readFile({ root: consumerRoot, candidate: resolve(consumerRoot, project), maxBytes: 2 * 1024 * 1024 }); }
        catch { invalidQualityInput(`Compiler project is missing, unreadable or outside the consumer: ${project}.`); }
      }
      const topology = mapQualityTopology(
        await configuration.read(consumerRoot, profile.featureProfilePath, "quality-topology", signal),
        profile.sourcePolicyPath
      );
      const authority = await ports.authority.source(consumerRoot, profile.sourcePolicyPath, signal);
      const suppressions = await ports.authority.suppressions(consumerRoot, profile.suppressionPolicyPath, signal);
      const inventory = await ports.inventory.read(consumerRoot, authority.workspaceManifestPath, signal);
      const scripts = scriptsFrom(await configuration.read(consumerRoot, "package.json", "quality-scripts", signal));
      const nativeToolingFiles = (profile.nativeChecks ?? []).flatMap(({ script }) => {
        const path = nativeScriptPath(scripts[script]);
        return path === undefined ? [] : [path];
      });
      const census = await ports.census.read({
        // Census is an independent repository observation.  Keep discovery broad;
        // topology is applied by classification and target projection below.
        consumerRoot, roots: ["."],
        ...(signal === undefined ? {} : { signal })
      });
      const classified = classifyQualityCensus({
        ...census, topology: { ...topology, toolingFiles: [...new Set([...(topology.toolingFiles ?? []), ...nativeToolingFiles])] },
        authority, suppressionRoots: suppressions.governedRoots,
        compilerProjects: profile.compilerProjects.map((project) => relative(resolve(consumerRoot), resolve(consumerRoot, project)).split(sep).join("/"))
      });
      const protection = await inspectProtectedConfig(consumerRoot, profile.lintConfigPath,
        (root, path) => configuration.read(root, path, "quality-lint-config", signal), {
          files: census.filePaths.filter((path) => !classified.compilerConfigPaths.includes(path)), production: classified.sources.map(({ path }) => path),
          tests: classified.testPaths
        });
      const nativeMappings = await Promise.all((profile.nativeChecks ?? []).map(async (mapping) => {
        if (!authority.boundaries.some(({ id }) => id === mapping.boundaryId)) {
          invalidQualityInput(`Native gate names an unknown source boundary: ${mapping.boundaryId}.`);
        }
        if (!classified.sources.some((source) => qualitySourceLanguage(source.path) === "native" && source.owners.includes(mapping.boundaryId))) {
          invalidQualityInput(`Native gate has no current native source: ${mapping.boundaryId}.`);
        }
        const command = scripts[mapping.script];
        const scriptPath = nativeScriptPath(command);
        let reached = false;
        if (command !== undefined && scriptPath !== undefined) {
          try { await readFile({ root: consumerRoot, candidate: resolve(consumerRoot, scriptPath), maxBytes: 2 * 1024 * 1024 }); }
          catch { invalidQualityInput(`Native gate script is missing or outside the consumer: ${mapping.script}.`); }
          reached = executesScript(scripts, profile.scripts.full, mapping.script, command);
        }
        return { ...mapping, reached };
      }));
      // Workspace selection is supplementary evidence, never the source census filter.
      const missingPackages = inventory.packages.filter(({ rootPath }) => rootPath !== "." &&
        !topology.excludedRoots.some((root) => rootPath === root || rootPath.startsWith(`${root}/`)) &&
        !topology.modules.some(({ root }) => root === rootPath)).map(({ manifestPath }) => manifestPath);
      assertNotCancelled(signal);
      return {
        ...classified,
        sources: classified.sources.map((source) => ({
          ...source,
          nativeGates: nativeMappings.filter(({ boundaryId }) => source.owners.includes(boundaryId))
            .map(({ script, reached }) => ({ script, reached }))
        })),
        unclassifiedPackages: [...new Set([...classified.unclassifiedPackages, ...missingPackages])].toSorted(),
        ...protection,
        requiredRoutes: [
          { entry: profile.scripts.fast, mode: "scope" },
          { entry: profile.scripts.full, mode: "full" }
        ],
        routes: [
          { entry: profile.scripts.fast, mode: "scope", reached: requiredRoute(scripts, profile.scripts.fast, profile.scripts.scope, true) },
          { entry: profile.scripts.full, mode: "full", reached: requiredRoute(scripts, profile.scripts.full, profile.scripts.typed, false) }
        ]
      };
    }
  };
}
