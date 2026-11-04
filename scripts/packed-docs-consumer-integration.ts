import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveGeneration2Node } from "./generation2-node.mts";
import { writePackedConsumerDocumentAuthoringFixture } from "./packed-consumer-document-authoring-fixture.mjs";
import {
  docsFixtureRecord,
  docsFixtureText,
  parseDocsExecution,
  runPackedDocsCommand as runCommand,
} from "./packed-docs-fixture-support.ts";
import type { PackedDocsArchive, PackedDocsPnpmRunner } from "./packed-docs-fixture-support.ts";
import type { QualifiedDocsCohortBindingV1 } from "../packages/docs-protocol-agent-teams/dist/consumer-integration/domain/model.js";
import {
  createRollbackFixturePackage,
  verifyPackedDocsAdapterHistory,
} from "./packed-docs-rollback-fixture.ts";

interface PackedDocsArtifactsInput {
  temporaryRoot: string;
  packageManager: string;
  runPnpm: PackedDocsPnpmRunner;
  adapter: PackedDocsArchive;
  authoring: PackedDocsArchive;
  docs: PackedDocsArchive;
  foundation: PackedDocsArchive;
  mutation: PackedDocsArchive;
}

export async function qualifyPackedDocsIntegration(input: PackedDocsArtifactsInput): Promise<void> {
  await verifyPackedDocsAdapterHistory(input.adapter, input.temporaryRoot);
  const adapter = await createRollbackFixturePackage(
    input.adapter,
    input.docs,
    input.foundation,
    input.mutation,
    input.temporaryRoot,
  );
  process.stdout.write(
    `Packed TEST rollback fixture (deliberately modified): ${adapter.archiveFileSpecifier}\n`,
  );
  await verifyPackedDocsConsumerIntegration({ ...input, adapter });
}

interface PackedDocsIntegrationInput {
  temporaryRoot: string;
  packageManager: string;
  runPnpm: PackedDocsPnpmRunner;
  adapter: Awaited<ReturnType<typeof createRollbackFixturePackage>>;
  authoring: PackedDocsArchive;
  docs: PackedDocsArchive;
  foundation: PackedDocsArchive;
  mutation: PackedDocsArchive;
}
interface InstalledDocsManifest {
  name: string;
  private: boolean;
  packageManager: string;
  devDependencies: Record<string, string>;
  scripts?: Record<string, unknown>;
}

export async function verifyPackedDocsConsumerIntegration(
  input: PackedDocsIntegrationInput,
): Promise<void> {
  const { consumerRoot, installedManifest } = await installDocsConsumer(input);
  await verifyInstalledDocsQueries(consumerRoot);
  await verifyManagedDocsLifecycle(input, consumerRoot, installedManifest);
}

async function installDocsConsumer(input: PackedDocsIntegrationInput) {
  const { temporaryRoot, runPnpm, packageManager } = input;
  const consumerRoot = join(temporaryRoot, "docs-consumer-tarball-e2e");
  await mkdir(join(consumerRoot, "architecture", "foundation"), { recursive: true });
  await runCommand("git", ["init", "-q"], consumerRoot);
  const installedManifest: InstalledDocsManifest = {
    name: "docs-consumer-tarball-e2e",
    private: true,
    packageManager,
    devDependencies: {
      "@agent-teams/document-authoring": input.authoring.archiveFileSpecifier,
      "@agent-teams/docs-protocol-agent-teams": input.adapter.archiveFileSpecifier,
      "@agent-teams/docs-protocol": input.docs.archiveFileSpecifier,
      "@agent-teams/engineering-foundation": input.foundation.archiveFileSpecifier,
      "@agent-teams/repository-mutation": input.mutation.archiveFileSpecifier,
    },
  };
  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(installedManifest, null, 2)}\n`,
  );
  const localArtifactOverrides = {
    "@agent-teams/document-authoring": input.authoring.archiveFileSpecifier,
    "@agent-teams/docs-protocol": input.docs.archiveFileSpecifier,
    "@agent-teams/engineering-foundation": input.foundation.archiveFileSpecifier,
    "@agent-teams/repository-mutation": input.mutation.archiveFileSpecifier,
  };
  await writeFile(
    join(consumerRoot, "pnpm-workspace.yaml"),
    `overrides:\n${Object.entries(localArtifactOverrides)
      .map(([name, specifier]) => `  ${JSON.stringify(name)}: ${JSON.stringify(specifier)}`)
      .join("\n")}\n`,
  );
  // The managed generation2 consumer contract still requires Node >=24.18.0 <25 in .node-version,
  // independent of the Node 26 repository default that runs this script.
  await writeFile(join(consumerRoot, ".node-version"), "24.21.0\n");
  await runPnpm(["install", "--ignore-scripts"], consumerRoot);
  await rm(join(consumerRoot, "node_modules"), { force: true, recursive: true });
  await runPnpm(["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], consumerRoot);
  await writePackedConsumerDocumentAuthoringFixture(consumerRoot);
  return { consumerRoot, installedManifest };
}

async function verifyInstalledDocsQueries(consumerRoot: string): Promise<void> {
  const authoringProbe = [
    "const module = await import('@agent-teams/document-authoring');",
    "if (typeof module.buildDocumentationCatalog !== 'function') process.exit(2);",
    "process.stdout.write(import.meta.resolve('@agent-teams/document-authoring'));",
  ].join("\n");
  const { stdout: authoringResolution } = await runCommand(
    process.execPath,
    ["--input-type=module", "--eval", authoringProbe],
    consumerRoot,
  );
  const resolvedAuthoring = new URL(authoringResolution.trim());
  if (
    resolvedAuthoring.protocol !== "file:" ||
    !resolvedAuthoring.pathname.includes(
      "/node_modules/@agent-teams/document-authoring/dist/index.js",
    ) ||
    resolvedAuthoring.pathname.includes("/.worktrees/")
  ) {
    throw new Error("Packed document-authoring export resolved outside the installed package.");
  }
  const docsCli = join(
    consumerRoot,
    "node_modules",
    "@agent-teams",
    "docs-protocol",
    "dist",
    "cli.js",
  );
  const found = parseDocsExecution(
    (
      await runCommand(
        process.execPath,
        [
          docsCli,
          "find",
          "hermetic search marker",
          "--consumer",
          consumerRoot,
          "--profile",
          "docs.config.yaml",
          "--json",
        ],
        consumerRoot,
      )
    ).stdout,
  );
  if (
    found["command"] !== "docs.find" ||
    found["outcome"] !== "success" ||
    docsFixtureRecord(found["result"])["matches"] !== 1 ||
    !hasPackagedDocument(found)
  ) {
    throw new Error("Packed Docs Protocol find did not return the deterministic catalog match.");
  }
}

function docsConsumerAuthority(
  consumerRoot: string,
  installedManifest: InstalledDocsManifest,
  initialCohort: QualifiedDocsCohortBindingV1,
) {
  let cohort = initialCohort;
  const desired = {
    schemaVersion: 1,
    repository: {
      provider: "github",
      id: "999999999",
      nameWithOwner: "agent-teams-ai/packed-docs-consumer-e2e",
    },
    integrationRoot: ".",
    packageManager: "pnpm",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    skillPath: ".agents/skills/docs-authoring/SKILL.md",
    callerWorkflowPath: ".github/workflows/docs-protocol.yml",
    managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
    cohort,
  };
  installedManifest.scripts = {};
  const writeAuthority = async () => {
    desired.cohort = cohort;
    installedManifest.devDependencies = {
      ...installedManifest.devDependencies,
      "@agent-teams/docs-protocol": cohort.packages.docsProtocol.version,
      "@agent-teams/engineering-foundation": cohort.packages.engineeringFoundation.version,
    };
    await writeFile(
      join(consumerRoot, "package.json"),
      `${JSON.stringify(installedManifest, null, 2)}\n`,
    );
    await writeFile(
      join(consumerRoot, "architecture", "foundation", "docs-consumer-integration.json"),
      `${JSON.stringify(desired, null, 2)}\n`,
    );
    await writeFile(
      join(consumerRoot, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      '@agent-teams/docs-protocol':
        specifier: ${cohort.packages.docsProtocol.version}
        version: ${cohort.packages.docsProtocol.version}
      '@agent-teams/engineering-foundation':
        specifier: ${cohort.packages.engineeringFoundation.version}
        version: ${cohort.packages.engineeringFoundation.version}
packages:
  '@agent-teams/docs-protocol@${cohort.packages.docsProtocol.version}':
    resolution: {integrity: ${cohort.packages.docsProtocol.integrity}}
  '@agent-teams/engineering-foundation@${cohort.packages.engineeringFoundation.version}':
    resolution: {integrity: ${cohort.packages.engineeringFoundation.integrity}}
snapshots:
  '@agent-teams/docs-protocol@${cohort.packages.docsProtocol.version}':
    dependencies:
      '@agent-teams/engineering-foundation': ${cohort.packages.engineeringFoundation.version}
  '@agent-teams/engineering-foundation@${cohort.packages.engineeringFoundation.version}': {}
`,
    );
  };
  return {
    cohortId: () => cohort.cohortId,
    write: writeAuthority,
    select(value: QualifiedDocsCohortBindingV1) {
      cohort = value;
    },
  };
}

async function docsIntegrationInvoker(consumerRoot: string) {
  const cli = join(
    consumerRoot,
    "node_modules",
    "@agent-teams",
    "docs-protocol-agent-teams",
    "dist",
    "cli.js",
  );
  // Only the managed generation2 adapter CLI runs on the explicit Node 24; everything else stays on the default.
  const generation2Node = await resolveGeneration2Node();
  const invoke = async (args: readonly string[]) => {
    try {
      const result = await runCommand(
        generation2Node,
        [cli, ...args, "--consumer", consumerRoot, "--json"],
        consumerRoot,
      );
      return parseDocsExecution(result.stdout);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stdout" in error &&
        typeof error.stdout === "string" &&
        error.stdout.trim() !== ""
      ) {
        return parseDocsExecution(error.stdout);
      }
      throw error;
    }
  };
  return invoke;
}

async function verifyManagedDocsLifecycle(
  input: PackedDocsIntegrationInput,
  consumerRoot: string,
  installedManifest: InstalledDocsManifest,
): Promise<void> {
  await writeFile(join(consumerRoot, "AGENTS.md"), "# Packed consumer\n");
  const authority = docsConsumerAuthority(consumerRoot, installedManifest, input.adapter.sourceB);
  await authority.write();
  const invoke = await docsIntegrationInvoker(consumerRoot);
  const previousRepositoryId = process.env["GITHUB_REPOSITORY_ID"];
  const previousRepository = process.env["GITHUB_REPOSITORY"];
  process.env["GITHUB_REPOSITORY_ID"] = "999999999";
  process.env["GITHUB_REPOSITORY"] = "agent-teams-ai/packed-docs-consumer-e2e";
  try {
    const checked = await invoke(["check"]);
    if (checked["outcome"] !== "change-required") {
      throw new Error(`Packed consumer check did not plan adoption: ${JSON.stringify(checked)}`);
    }
    const planned = await invoke(["plan", "--to", authority.cohortId()]);
    if (planned["outcome"] !== "change-required") {
      throw new Error("Packed consumer plan did not require adoption.");
    }
    const applied = await invoke([
      "apply",
      "--expect",
      docsFixtureText(docsFixtureRecord(planned["plan"])["planDigest"]),
    ]);
    if (process.platform === "win32") {
      if (applied["outcome"] !== "blocked" || !hasUnsupportedApplyIssue(applied)) {
        throw new Error(
          `Packed Windows consumer apply did not fail closed: ${JSON.stringify(applied)}`,
        );
      }
      const unchanged = await invoke(["check"]);
      if (unchanged["outcome"] !== "change-required") {
        throw new Error("Packed Windows apply refusal changed the consumer.");
      }
      return;
    }
    if (applied["outcome"] !== "applied") {
      throw new Error(`Packed consumer apply did not commit adoption: ${JSON.stringify(applied)}`);
    }
    const current = await invoke(["check"]);
    if (current["outcome"] !== "current") {
      throw new Error("Packed consumer check did not converge.");
    }
    installedManifest.scripts = docsFixtureRecord(
      docsFixtureRecord(JSON.parse(await readFile(join(consumerRoot, "package.json"), "utf8")))[
        "scripts"
      ],
    );

    authority.select(input.adapter.targetA);
    await authority.write();
    const rollbackPlan = await invoke(["plan", "--to", authority.cohortId()]);
    if (rollbackPlan["outcome"] !== "change-required") {
      throw new Error(
        `Packed source executor did not plan B to A rollback: ${JSON.stringify(rollbackPlan)}`,
      );
    }
    const rollback = await invoke([
      "apply",
      "--expect",
      docsFixtureText(docsFixtureRecord(rollbackPlan["plan"])["planDigest"]),
    ]);
    if (rollback["outcome"] !== "applied") {
      throw new Error("Packed source executor did not apply B to A rollback.");
    }
    const rolledBack = await invoke(["check"]);
    if (rolledBack["outcome"] !== "current") {
      throw new Error("Packed B to A rollback did not converge.");
    }
  } finally {
    if (previousRepositoryId === undefined) {
      delete process.env["GITHUB_REPOSITORY_ID"];
    } else {
      process.env["GITHUB_REPOSITORY_ID"] = previousRepositoryId;
    }
    if (previousRepository === undefined) {
      delete process.env["GITHUB_REPOSITORY"];
    } else {
      process.env["GITHUB_REPOSITORY"] = previousRepository;
    }
  }
}

function hasPackagedDocument(report: Record<string, unknown>): boolean {
  const documents = docsFixtureRecord(report["result"])["documents"];
  return (
    Array.isArray(documents) &&
    documents.length > 0 &&
    docsFixtureRecord(documents[0])["id"] === "guide.packaged"
  );
}

function hasUnsupportedApplyIssue(report: Record<string, unknown>): boolean {
  const issues = report["issues"];
  return (
    Array.isArray(issues) &&
    issues.some(
      (value: unknown) => docsFixtureRecord(value)["code"] === "KNOWN_FILE_APPLY_UNSUPPORTED",
    )
  );
}
