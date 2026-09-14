import {
  assertNotCancelled,
  type ManagedProcessExecutor, type QualityFileReader,
  type QualityObservationPorts, type QualityToolProvider
} from "../api.js";
import type { QualityConfigurationReader } from "./consumer-observations.js";
import { inspectConsumerToolchain } from "./consumer-toolchain.js";
import { createOxlintSession } from "./oxlint-session.js";
import { invalidQualityInput, mapQualityProfile, mapQualityTopology } from "./profile-input.js";

/** Bind one invocation to consumer-local tools and the module-owned compiler projects. */
export function createQualityToolProvider(input: {
  readonly ports: QualityObservationPorts;
  readonly configuration: QualityConfigurationReader;
  readonly readFile: QualityFileReader;
  readonly executor: ManagedProcessExecutor;
  readonly nodeExecutable: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): QualityToolProvider {
  return {
    async prepare(consumerRoot, configPath, signal) {
      assertNotCancelled(signal);
      const value = await input.configuration.read(consumerRoot, configPath, "quality-profile", signal);
      await input.configuration.assertProfile(value);
      const profile = mapQualityProfile(value);
      const topology = mapQualityTopology(
        await input.configuration.read(consumerRoot, profile.featureProfilePath, "quality-topology", signal),
        profile.sourcePolicyPath
      );
      const authority = await input.ports.authority.source(consumerRoot, profile.sourcePolicyPath, signal);
      const inventory = await input.ports.inventory.read(consumerRoot, authority.workspaceManifestPath, signal);
      const rootPackage = inventory.packages.find(({ manifestPath }) => manifestPath === "package.json");
      if (rootPackage === undefined) { invalidQualityInput("The consumer root package is missing from workspace observations."); }
      const tools = await inspectConsumerToolchain({
        consumerRoot, dependencies: rootPackage.dependencies, read: input.readFile,
        ...(signal === undefined ? {} : { signal })
      });
      assertNotCancelled(signal);
      return createOxlintSession({
        consumerRoot, ...tools, nodeExecutable: input.nodeExecutable,
        environment: { ...input.environment, OXLINT_TSGOLINT_PATH: tools.typedEntrypoint },
        configPath: profile.lintConfigPath,
        sourceRoots: [...topology.modules.map(({ sourceRoot }) => sourceRoot), ...topology.applicationRoots],
        projects: profile.compilerProjects
      }, input.executor);
    }
  };
}
