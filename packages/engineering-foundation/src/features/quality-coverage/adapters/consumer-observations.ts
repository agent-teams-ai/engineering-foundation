import { realpath } from "node:fs/promises";
import {
  createQualityInputWitness,
  qualityInputDigest,
  type QualityResolutionBinding,
} from "./quality-input-witness.js";
import { admitQualityProfileVersion } from "./configuration.js";
import { relative, resolve, sep } from "node:path";
import { inspectRetiredTemporaryDuplicates } from "@agent-teams/repository-mutation/node";
import {
  assertNotCancelled,
  CapabilityInputError,
  classifyQualityCensus,
  executesScript,
  qualityHostCommand,
  type QualityCoverageObservation,
  type QualityCoverageSession,
  type QualityCoverageProfile,
  type QualityTopology,
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

export type QualityYamlReader = (
  consumerRoot: string,
  path: string,
  phase: string,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface QualityConfigurationReader {
  assertProfile(value: unknown): Promise<void>;
  createReader(input: { readonly read: QualityFileReader }): QualityYamlReader;
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
    } catch (error) {
      if (error instanceof CapabilityInputError) {
        throw error;
      }
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
  createObservedPorts?: (
    read: QualityFileReader,
    readYaml: QualityYamlReader,
  ) => QualityObservationPorts,
): QualityCoverageReader {
  return {
    async read(
      requestedRoot,
      configPath,
      signal,
      observeSchemaVersion,
    ): Promise<QualityCoverageSession> {
      assertNotCancelled(signal);
      const consumerRoot = await realpath(requestedRoot);
      const witness = createQualityInputWitness(consumerRoot, readFile, signal);
      const readYaml = configuration.createReader({ read: witness.read });
      const observedPorts = createObservedPorts?.(witness.read, readYaml) ?? ports;
      const value = await readYaml(consumerRoot, configPath, "quality-profile", signal);
      admitQualityProfileVersion(value, observeSchemaVersion);
      await configuration.assertProfile(value);
      const profile = await readConfiguredQualityProfile(
        value,
        consumerRoot,
        { read: readYaml },
        signal,
      );
      witness.setBudget(profile.budgetMs);
      await witness.capture(observedPorts.census);
      await requireCompilerProjects(profile.compilerProjects, consumerRoot, witness.read);
      const topology = mapQualityTopology(
        await readYaml(consumerRoot, profile.topologyPath, "quality-topology", signal),
      );
      for (const binding of topology.derivedFrom ?? []) {
        const bytes = await witness.read({
          root: consumerRoot,
          candidate: resolve(consumerRoot, binding.path),
          maxBytes: 16 * 1024 * 1024,
        });
        if (qualityInputDigest(bytes) !== binding.sha256) {
          invalidQualityInput(
            "Generated quality topology is stale; regenerate its source-bound projection.",
          );
        }
      }
      const { observation, authority, inventory } = await observeQualityFacts({
        consumerRoot,
        profile,
        topology,
        ports: observedPorts,
        readYaml,
        readFile: witness.read,
        bindResolution: (binding: QualityResolutionBinding) => witness.bindResolution(binding),
        retirementBudget: witness.retirementBudget,
        signal,
      });
      return Object.freeze({
        consumerRoot,
        observation: freezeQualityFacts(observation),
        profile: freezeQualityFacts(profile),
        topology,
        authority: freezeQualityFacts(authority),
        dependencies: freezeQualityFacts(
          inventory.packages.find(({ manifestPath }) => manifestPath === "package.json")
            ?.dependencies ?? [],
        ),
        readFile: witness.read,
        readToolFile: witness.readToolFile,
        remainingMs: () => witness.remainingMs(),
        verify: (verificationSignal?: AbortSignal) => witness.verify(verificationSignal),
        readBridgeAdmissions: (scanSignal?: AbortSignal) =>
          profile.bridgeAdmissionsPath === undefined
            ? Promise.resolve()
            : readYaml(
                consumerRoot,
                profile.bridgeAdmissionsPath,
                "quality-bridge-admissions",
                scanSignal,
              ),
      });
    },
  };
}

async function observeQualityFacts(input: {
  readonly consumerRoot: string;
  readonly profile: QualityCoverageProfile;
  readonly topology: QualityTopology;
  readonly ports: QualityObservationPorts;
  readonly readYaml: QualityYamlReader;
  readonly readFile: QualityFileReader;
  readonly bindResolution: (binding: QualityResolutionBinding) => Promise<void>;
  readonly retirementBudget: NonNullable<Parameters<typeof inspectRetiredTemporaryDuplicates>[2]>;
  readonly signal: AbortSignal | undefined;
}) {
  const { consumerRoot, profile, topology, ports, readYaml, readFile, bindResolution, signal } =
    input;
  const authority = await ports.authority.source(consumerRoot, profile.sourcePolicyPath, signal);
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
    await readYaml(consumerRoot, "package.json", "quality-scripts", signal),
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
        ...topology.sourceRoots,
        ...authority.boundaries
          .filter(({ dependencyMode }) => dependencyMode === "runtime")
          .flatMap(({ roots }) => roots),
      ]),
    ],
    ...(signal === undefined ? {} : { signal }),
  });
  const duplicates = new Set(
    (
      await inspectRetiredTemporaryDuplicates(
        consumerRoot,
        census.filePaths,
        input.retirementBudget,
      )
    ).map(({ path }) => path),
  );
  const classified = classifyQualityCensus({
    ...census,
    filePaths: census.filePaths.filter((path) => !duplicates.has(path)),
    topology: {
      ...topology,
      toolingFiles: [...new Set([...topology.toolingFiles, ...nativeToolingFiles])],
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
    (root, path) => readYaml(root, path, "quality-lint-config", signal),
    {
      files: census.filePaths.filter((path) => !classified.compilerConfigPaths.includes(path)),
      production: classified.sources.map(({ path }) => path),
      tests: classified.testPaths,
    },
    bindResolution,
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
        !topology.excludedRoots.some(
          (root) => rootPath === root || rootPath.startsWith(`${root}/`),
        ) && !topology.packageRoots.includes(rootPath),
    )
    .map(({ manifestPath }) => manifestPath);
  assertNotCancelled(signal);
  const observation: QualityCoverageObservation = {
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
  return { observation, authority, inventory };
}

function freezeQualityFacts<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      freezeQualityFacts(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** Resolve v5's sole project authority as inert configuration, shared by observation and execution. */
export async function readConfiguredQualityProfile(
  value: unknown,
  consumerRoot: string,
  configuration: { readonly read: QualityYamlReader },
  signal?: AbortSignal,
) {
  const raw = qualityRecord(value);
  admitQualityProfileVersion(raw);
  const toolchainConfigPath = qualityString(raw["toolchainConfigPath"]);
  const config = qualityRecord(
    await configuration.read(consumerRoot, toolchainConfigPath, "quality-toolchain-config", signal),
  );
  const projects = qualityStrings(qualityRecord(config["typecheck"])["projects"]);
  return mapQualityProfile({ ...raw, compilerProjects: projects });
}
