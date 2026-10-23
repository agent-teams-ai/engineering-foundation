import { relative, resolve, sep } from "node:path";
import { inspectRetiredTemporaryDuplicates } from "@agent-teams/repository-mutation/node";
import {
  assertNotCancelled,
  classifyQualityCensus,
  executesScript,
  qualityHostCommand,
  type QualityCoverageObservation,
  type QualityCoverageReader,
  type QualityObservationPorts,
  type QualityFileReader,
} from "../api.js";
import {
  nativeScriptPath,
  readNativeGateMappings,
  readAssetGateMappings,
} from "./consumer-gate-mappings.js";
import { inspectProtectedConfig } from "./protected-config.js";
import {
  invalidQualityInput,
  mapQualityProfile,
  mapQualityTopology,
  qualityRecord,
  qualityScriptCommand,
  qualityString,
  qualityStrings,
} from "./profile-input.js";

export interface QualityConfigurationReader {
  read(consumerRoot: string, path: string, phase: string, signal?: AbortSignal): Promise<unknown>;
  assertProfile(value: unknown): Promise<void>;
}

function scriptsFrom(value: unknown): Readonly<Record<string, string>> {
  const scripts = qualityRecord(qualityRecord(value)["scripts"]);
  return Object.fromEntries(
    Object.entries(scripts).map(([name, command]) => [name, qualityScriptCommand(command)]),
  );
}

function requiredRoute(
  scripts: Readonly<Record<string, string>>,
  entry: string,
  target: string,
  scopeOnly: boolean,
): boolean {
  const suffix = ` quality check --consumer .${scopeOnly ? " --scope-only" : ""}`;
  const hostCommand = scripts[target];
  return [
    ...(hostCommand !== undefined && qualityHostCommand(hostCommand, scopeOnly)
      ? [hostCommand]
      : []),
    `agent-teams-foundation${suffix}`,
    `node packages/engineering-foundation/dist/cli.js${suffix}`,
    `node tools/repository-command.mts tool ${scopeOnly ? "quality:coverage:scope" : "lint:typed"}`,
  ].some((expected) => executesScript(scripts, entry, target, expected));
}

async function requireCompilerProjects(
  projects: readonly string[],
  consumerRoot: string,
  readFile: QualityFileReader,
): Promise<void> {
  for (const project of projects) {
    try {
      await readFile({
        root: consumerRoot,
        candidate: resolve(consumerRoot, project),
        maxBytes: 2 * 1024 * 1024,
      });
    } catch {
      invalidQualityInput(
        `Compiler project is missing, unreadable or outside the consumer: ${project}.`,
      );
    }
  }
}

/** The same static observation is used by aggregate checks and explicit execution. */
export function createQualityCoverageReader(
  ports: QualityObservationPorts,
  configuration: QualityConfigurationReader,
  readFile: QualityFileReader,
): QualityCoverageReader {
  return {
    async read(consumerRoot, configPath, signal): Promise<QualityCoverageObservation> {
      assertNotCancelled(signal);
      const value = await configuration.read(consumerRoot, configPath, "quality-profile", signal);
      await configuration.assertProfile(value);
      const profile = await readConfiguredQualityProfile(
        value,
        consumerRoot,
        configuration,
        signal,
      );
      await requireCompilerProjects(profile.compilerProjects, consumerRoot, readFile);
      const topology = mapQualityTopology(
        await configuration.read(
          consumerRoot,
          profile.featureProfilePath,
          "quality-topology",
          signal,
        ),
        profile.sourcePolicyPath,
      );
      const authority = await ports.authority.source(
        consumerRoot,
        profile.sourcePolicyPath,
        signal,
      );
      const suppressions = await ports.authority.suppressions(
        consumerRoot,
        profile.suppressionPolicyPath,
        signal,
      );
      const inventory = await ports.inventory.read(
        consumerRoot,
        authority.workspaceManifestPath,
        signal,
      );
      const scripts = scriptsFrom(
        await configuration.read(consumerRoot, "package.json", "quality-scripts", signal),
      );
      const nativeToolingFiles = (profile.nativeChecks ?? []).flatMap(({ script }) => {
        const path = nativeScriptPath(scripts[script]);
        return path === undefined ? [] : [path];
      });
      const census = await ports.census.read({
        // Keep the repository census broad while reopening explicitly owned
        // source beneath ordinary package-level generated-output exclusions.
        consumerRoot,
        roots: [
          ...new Set([
            ".",
            ...(topology.productionSourceRoots ?? [
              ...topology.modules.map(({ sourceRoot }) => sourceRoot),
              ...topology.applicationRoots,
            ]),
            ...authority.boundaries
              .filter(({ dependencyMode }) => dependencyMode === "runtime")
              .flatMap(({ roots }) => roots),
          ]),
        ],
        ...(signal === undefined ? {} : { signal }),
      });
      const duplicates = new Set(
        (await inspectRetiredTemporaryDuplicates(consumerRoot, census.filePaths)).map(
          ({ path }) => path,
        ),
      );
      const classified = classifyQualityCensus({
        ...census,
        filePaths: census.filePaths.filter((path) => !duplicates.has(path)),
        topology: {
          ...topology,
          toolingFiles: [...new Set([...(topology.toolingFiles ?? []), ...nativeToolingFiles])],
        },
        authority,
        suppressionRoots: suppressions.governedRoots,
        compilerProjects: profile.compilerProjects.map((project) =>
          relative(resolve(consumerRoot), resolve(consumerRoot, project)).split(sep).join("/"),
        ),
      });
      const protection = await inspectProtectedConfig(
        consumerRoot,
        profile.lintConfigPath,
        (root, path) => configuration.read(root, path, "quality-lint-config", signal),
        {
          files: census.filePaths.filter((path) => !classified.compilerConfigPaths.includes(path)),
          production: classified.sources.map(({ path }) => path),
          tests: classified.testPaths,
        },
      );
      const mappingInput = { consumerRoot, profile, scripts, readFile };
      const nativeMappings = await readNativeGateMappings(
        mappingInput,
        authority.boundaries,
        classified.sources,
      );
      const assetMappings = await readAssetGateMappings(mappingInput, classified.sources);
      // Workspace selection is supplementary evidence, never the source census filter.
      const missingPackages = inventory.packages
        .filter(
          ({ rootPath }) =>
            rootPath !== "." &&
            !topology.excludedRoots.some(
              (root) => rootPath === root || rootPath.startsWith(`${root}/`),
            ) &&
            !topology.modules.some(({ root }) => root === rootPath),
        )
        .map(({ manifestPath }) => manifestPath);
      assertNotCancelled(signal);
      return {
        ...classified,
        sources: classified.sources.map((source) => ({
          ...source,
          nativeGates: nativeMappings
            .filter(({ boundaryId }) => source.owners.includes(boundaryId))
            .map(({ script, reached }) => ({ script, reached })),
          ...(assetMappings.some(({ path }) => path === source.path)
            ? {
                assetGates: assetMappings
                  .filter(({ path }) => path === source.path)
                  .map(({ script, reached }) => ({ script, reached })),
              }
            : {}),
        })),
        unclassifiedPackages: [
          ...new Set([...classified.unclassifiedPackages, ...missingPackages]),
        ].toSorted(),
        ...protection,
        requiredRoutes: [
          { entry: profile.scripts.fast, mode: "scope" },
          { entry: profile.scripts.full, mode: "full" },
        ],
        routes: [
          {
            entry: profile.scripts.fast,
            mode: "scope",
            reached: requiredRoute(scripts, profile.scripts.fast, profile.scripts.scope, true),
          },
          {
            entry: profile.scripts.full,
            mode: "full",
            reached: requiredRoute(scripts, profile.scripts.full, profile.scripts.typed, false),
          },
        ],
      };
    },
  };
}

/** Resolve v4's sole project authority as inert configuration, shared by observation and execution. */
export async function readConfiguredQualityProfile(
  value: unknown,
  consumerRoot: string,
  configuration: QualityConfigurationReader,
  signal?: AbortSignal,
) {
  const raw = qualityRecord(value);
  if (raw["schemaVersion"] !== 4) {
    return mapQualityProfile(raw);
  }
  const toolchainConfigPath = qualityString(raw["toolchainConfigPath"]);
  const config = qualityRecord(
    await configuration.read(consumerRoot, toolchainConfigPath, "quality-toolchain-config", signal),
  );
  const projects = qualityStrings(qualityRecord(config["typecheck"])["projects"]);
  return mapQualityProfile({ ...raw, compilerProjects: projects });
}
