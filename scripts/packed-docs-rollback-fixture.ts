import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPackedDocsAdapterHistory } from "./pack-docs-adapter-history.mjs";
import type { QualifiedDocsCohortBindingV1 } from "../packages/docs-protocol-agent-teams/dist/consumer-integration/domain/model.js";
import {
  docsFixtureDigest as sha256,
  docsFixtureRecord,
  docsFixtureText,
  installedDocsTextCall,
  installedDocsDigestCall,
  runPackedDocsCommand as runCommand,
} from "./packed-docs-fixture-support.ts";
import type { PackedDocsArchive } from "./packed-docs-fixture-support.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export async function verifyPackedDocsAdapterHistory(
  adapterArtifact: PackedDocsArchive,
  temporaryRoot: string,
) {
  const root = join(temporaryRoot, "docs-adapter-history-inspection");
  await mkdir(root, { recursive: true });
  await runCommand("tar", ["-xzf", adapterArtifact.archivePath, "-C", root], temporaryRoot);
  const packageRoot = join(root, "package");
  const transitionCatalogBytes = await readFile(
    join(packageRoot, "assets", "transition-catalog.json"),
  );
  const transitionCatalog = docsFixtureRecord(JSON.parse(transitionCatalogBytes.toString("utf8")));
  const stable23 = docsFixtureRecord(assertPackedDocsAdapterHistory(transitionCatalog));
  for (const [path, expectedDigest] of [
    [
      docsFixtureText(stable23["skillPath"]),
      "sha256:a86d8c9b990124f11b50b1c6703e1aeb5e3b981d51f7e8f5c163c4f5b987d7c5",
    ],
    [
      docsFixtureText(stable23["callerWorkflowPath"]),
      "sha256:d8d3b1281990179ee25ded67ba160f0e7573d2f70707b8c5b312d70b68d85125",
    ],
  ]) {
    if (sha256(await readFile(join(packageRoot, path))) !== expectedDigest) {
      throw new Error(`Packed adapter historical asset digest mismatch: ${path}.`);
    }
  }
  const api = docsFixtureRecord(
    await import(
      `${
        pathToFileURL(
          join(packageRoot, "dist", "consumer-integration", "generated", "canonical-assets.js"),
        ).href
      }?history-inspection=1`
    ),
  );
  if (api["GENERATED_TRANSITION_CATALOG"] !== transitionCatalogBytes.toString("utf8")) {
    throw new Error("Packed adapter generated transition authority differs from its asset bytes.");
  }
}

function rollbackFixtureRuntimeLock(cohort: QualifiedDocsCohortBindingV1) {
  const docsLocator = `@agent-teams/docs-protocol@${cohort.packages.docsProtocol.version}`;
  const foundationLocator = `@agent-teams/engineering-foundation@${cohort.packages.engineeringFoundation.version}`;
  return {
    lockfileVersion: "9.0",
    importers: {
      ".": {
        devDependencies: {
          "@agent-teams/docs-protocol": {
            specifier: cohort.packages.docsProtocol.version,
            version: cohort.packages.docsProtocol.version,
          },
          "@agent-teams/engineering-foundation": {
            specifier: cohort.packages.engineeringFoundation.version,
            version: cohort.packages.engineeringFoundation.version,
          },
        },
      },
    },
    packages: {
      [docsLocator]: { resolution: { integrity: cohort.packages.docsProtocol.integrity } },
      [foundationLocator]: {
        resolution: { integrity: cohort.packages.engineeringFoundation.integrity },
      },
    },
    snapshots: {
      [docsLocator]: {
        dependencies: {
          "@agent-teams/engineering-foundation": cohort.packages.engineeringFoundation.version,
        },
      },
      [foundationLocator]: {},
    },
  };
}

type RollbackCohorts = {
  sourceB: QualifiedDocsCohortBindingV1;
  targetA: QualifiedDocsCohortBindingV1;
  targetSkill: Buffer;
  targetCaller: Buffer;
};

export async function createRollbackFixturePackage(
  adapterArtifact: PackedDocsArchive,
  docsArtifact: PackedDocsArchive,
  foundationArtifact: PackedDocsArchive,
  mutationArtifact: PackedDocsArchive,
  temporaryRoot: string,
) {
  const { root, extractedPackageRoot, api, closureApi, packageManifest } =
    await prepareRollbackPackage(
      adapterArtifact,
      docsArtifact,
      foundationArtifact,
      mutationArtifact,
      temporaryRoot,
    );
  const cohorts = await createRollbackCohorts(api, closureApi, packageManifest);
  const { sourceB, targetA } = await writeRollbackCatalog(extractedPackageRoot, api, cohorts);
  const archivePath = join(
    temporaryRoot,
    "agent-teams-docs-protocol-agent-teams-rollback-fixture.tgz",
  );
  await runCommand("tar", ["-czf", archivePath, "package"], root);
  return {
    archiveFileSpecifier: `file:${archivePath.replaceAll("\\", "/")}`,
    sourceB,
    targetA,
  };
}

async function prepareRollbackPackage(
  adapterArtifact: PackedDocsArchive,
  docsArtifact: PackedDocsArchive,
  foundationArtifact: PackedDocsArchive,
  mutationArtifact: PackedDocsArchive,
  temporaryRoot: string,
) {
  const root = join(temporaryRoot, "docs-rollback-package-fixture");
  await mkdir(root, { recursive: true });
  await runCommand("tar", ["-xzf", adapterArtifact.archivePath, "-C", root], temporaryRoot);
  // Supply the packed helpers' dependency outside the package being re-archived.
  const mutationPackageRoot = join(root, "node_modules", "@agent-teams", "repository-mutation");
  await mkdir(mutationPackageRoot, { recursive: true });
  await runCommand(
    "tar",
    ["-xzf", mutationArtifact.archivePath, "--strip-components=1", "-C", mutationPackageRoot],
    temporaryRoot,
  );
  const extractedPackageRoot = join(root, "package");
  const api = docsFixtureRecord(
    await import(
      `${
        pathToFileURL(
          join(
            extractedPackageRoot,
            "dist",
            "consumer-integration",
            "application",
            "policies",
            "consumer-integration-assets.js",
          ),
        ).href
      }?rollback-fixture=1`
    ),
  );
  const closureApi = docsFixtureRecord(
    await import(
      `${
        pathToFileURL(
          join(
            extractedPackageRoot,
            "dist",
            "consumer-integration",
            "adapters",
            "pnpm-runtime-closure-v1.js",
          ),
        ).href
      }?rollback-fixture=1`
    ),
  );
  const packageManifest = docsFixtureRecord(
    JSON.parse(await readFile(join(extractedPackageRoot, "package.json"), "utf8")),
  );
  const dependencies = docsFixtureRecord(packageManifest["dependencies"]);
  packageManifest["dependencies"] = dependencies;
  dependencies["@agent-teams/docs-protocol"] = docsArtifact.archiveFileSpecifier;
  dependencies["@agent-teams/engineering-foundation"] = foundationArtifact.archiveFileSpecifier;
  dependencies["@agent-teams/repository-mutation"] = mutationArtifact.archiveFileSpecifier;
  await writeFile(
    join(extractedPackageRoot, "package.json"),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
  );
  return { root, extractedPackageRoot, api, closureApi, packageManifest };
}

async function createRollbackCohorts(
  api: Record<string, unknown>,
  closureApi: Record<string, unknown>,
  packageManifest: Record<string, unknown>,
): Promise<RollbackCohorts> {
  const integrity: `sha512-${string}` = `sha512-${"A".repeat(86)}==`;
  const common: Pick<
    QualifiedDocsCohortBindingV1,
    | "schemaVersion"
    | "channel"
    | "eligibleAfter"
    | "upgradeFrom"
    | "packages"
    | "schemas"
    | "runtime"
  > = {
    schemaVersion: 1,
    channel: "rc",
    eligibleAfter: "2026-08-16T00:00:00Z",
    upgradeFrom: [],
    packages: {
      docsProtocol: { version: docsFixtureText(packageManifest["version"]), integrity },
      engineeringFoundation: {
        version: docsFixtureText(
          docsFixtureRecord(
            JSON.parse(
              await readFile(
                join(repositoryRoot, "packages", "engineering-foundation", "package.json"),
                "utf8",
              ),
            ),
          )["version"],
        ),
        integrity,
      },
    },
    schemas: { consumerIntegration: 1, managedState: 1, docsProtocol: 1 },
    runtime: {
      node: ">=24.18.0 <25",
      pnpm: ">=11.17.0 <12",
      runtimeClosureDigest: `sha256:${"e".repeat(64)}`,
    },
  };
  let targetA: QualifiedDocsCohortBindingV1 = {
    ...common,
    cohortId: "packed-target-a",
    recordDigest: `sha256:${"a".repeat(64)}`,
    qualificationEventDigest: `sha256:${"b".repeat(64)}`,
    rollbackTo: [],
    workflow: {
      repository: "agent-teams-ai/.github",
      path: ".github/workflows/docs-protocol-check.yml",
      revision: "6".repeat(40),
      blobSha: "7".repeat(40),
    },
    assets: {
      skillDigest: `sha256:${"0".repeat(64)}`,
      callerWorkflowDigest: `sha256:${"0".repeat(64)}`,
      assetCatalogDigest: `sha256:${"9".repeat(64)}`,
      transitionCatalogDigest: `sha256:${"8".repeat(64)}`,
    },
  };
  targetA = {
    ...targetA,
    packages: {
      docsProtocol: { version: "0.0.9", integrity },
      engineeringFoundation: { version: "0.16.1", integrity },
    },
  };
  const targetSkill = Buffer.from(
    `${docsFixtureText(api["CANONICAL_DOCS_SKILL"])}\n<!-- qualified target A -->\n`,
  );
  const targetCaller = Buffer.from(
    installedDocsTextCall(api, "canonicalCallerWorkflow", [targetA]),
  );
  targetA = {
    ...targetA,
    assets: {
      ...targetA.assets,
      skillDigest: sha256(targetSkill),
      callerWorkflowDigest: sha256(targetCaller),
    },
  };
  let sourceB: QualifiedDocsCohortBindingV1 = {
    ...common,
    cohortId: "packed-source-b",
    recordDigest: `sha256:${"c".repeat(64)}`,
    qualificationEventDigest: `sha256:${"d".repeat(64)}`,
    rollbackTo: [targetA.cohortId],
    workflow: {
      repository: "agent-teams-ai/.github",
      path: ".github/workflows/docs-protocol-check.yml",
      revision: "1".repeat(40),
      blobSha: "2".repeat(40),
    },
    assets: {
      skillDigest: sha256(Buffer.from(docsFixtureText(api["CANONICAL_DOCS_SKILL_V2"]))),
      callerWorkflowDigest: `sha256:${"0".repeat(64)}`,
      assetCatalogDigest: `sha256:${"0".repeat(64)}`,
      transitionCatalogDigest: `sha256:${"0".repeat(64)}`,
    },
  };
  sourceB = {
    ...sourceB,
    assets: {
      ...sourceB.assets,
      callerWorkflowDigest: sha256(
        Buffer.from(installedDocsTextCall(api, "canonicalCallerWorkflow", [sourceB])),
      ),
    },
  };
  sourceB = {
    ...sourceB,
    runtime: {
      ...sourceB.runtime,
      runtimeClosureDigest: installedDocsDigestCall(
        closureApi,
        "computePnpmRuntimeClosureDigestV1",
        [rollbackFixtureRuntimeLock(sourceB), sourceB],
      ),
    },
  };
  targetA = {
    ...targetA,
    runtime: {
      ...targetA.runtime,
      runtimeClosureDigest: installedDocsDigestCall(
        closureApi,
        "computePnpmRuntimeClosureDigestV1",
        [rollbackFixtureRuntimeLock(targetA), targetA],
      ),
    },
  };
  return { sourceB, targetA, targetSkill, targetCaller };
}

async function writeRollbackCatalog(
  extractedPackageRoot: string,
  api: Record<string, unknown>,
  cohorts: RollbackCohorts,
): Promise<{ sourceB: QualifiedDocsCohortBindingV1; targetA: QualifiedDocsCohortBindingV1 }> {
  let { sourceB } = cohorts;
  const { targetA, targetSkill, targetCaller } = cohorts;
  const skillPath = `assets/history/sha256-${targetA.assets.skillDigest.slice(7)}/skill.md`;
  const callerPath = `assets/history/sha256-${targetA.assets.callerWorkflowDigest.slice(7)}/caller.yml`;
  await mkdir(join(extractedPackageRoot, skillPath, ".."), { recursive: true });
  await mkdir(join(extractedPackageRoot, callerPath, ".."), { recursive: true });
  await writeFile(join(extractedPackageRoot, skillPath), targetSkill);
  await writeFile(join(extractedPackageRoot, callerPath), targetCaller);
  const catalogBytes = await readFile(join(extractedPackageRoot, "assets", "catalog.json"));
  sourceB = { ...sourceB, assets: { ...sourceB.assets, assetCatalogDigest: sha256(catalogBytes) } };
  const transitionCatalog = docsFixtureRecord(
    JSON.parse(
      await readFile(join(extractedPackageRoot, "assets", "transition-catalog.json"), "utf8"),
    ),
  );
  const currentSourceExecutor = {
    schemas: sourceB.schemas,
    runtime: sourceB.runtime,
    packages: sourceB.packages,
    assetCatalogDigest: sourceB.assets.assetCatalogDigest,
    skillDigest: sourceB.assets.skillDigest,
    callerWorkflowDigest: sourceB.assets.callerWorkflowDigest,
    agentsRouteDigest: sha256(
      Buffer.from(
        installedDocsTextCall(api, "canonicalManagedRoute", [
          ".agents/skills/docs-authoring/SKILL.md",
        ]),
      ),
    ),
    docsScriptsDigest: installedDocsDigestCall(api, "canonicalDocsScriptsDigest", [
      "architecture/foundation/docs-protocol.yaml",
    ]),
    directTargetCohortIds: [targetA.cohortId],
  };
  transitionCatalog["currentSourceExecutors"] = [currentSourceExecutor];
  transitionCatalog["directTargetBundles"] = [
    {
      cohort: targetA,
      skillPath,
      skillDigest: targetA.assets.skillDigest,
      callerWorkflowPath: callerPath,
      callerWorkflowDigest: targetA.assets.callerWorkflowDigest,
      agentsRouteDigest: currentSourceExecutor.agentsRouteDigest,
      docsScriptsDigest: currentSourceExecutor.docsScriptsDigest,
    },
  ];
  const transitionCatalogBytes = Buffer.from(`${JSON.stringify(transitionCatalog)}\n`);
  sourceB = {
    ...sourceB,
    assets: { ...sourceB.assets, transitionCatalogDigest: sha256(transitionCatalogBytes) },
  };
  await writeFile(
    join(extractedPackageRoot, "assets", "transition-catalog.json"),
    transitionCatalogBytes,
  );
  return { sourceB, targetA };
}
