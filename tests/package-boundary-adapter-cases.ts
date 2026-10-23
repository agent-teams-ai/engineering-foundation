import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { createSourceDependenciesCapability } from "../packages/engineering-foundation/dist/capabilities/source-dependencies/module.js";
import { sourceDependencyAdapters } from "./support/capability-adapters.mjs";
import { parseBoundaryFixture } from "./package-boundary-policy-fixture.ts";
const repositoryRoot = resolve(import.meta.dirname, "..");
const docsProtocolAgentTeamsName = "@agent-teams/docs-protocol-agent-teams";
export function registerAdapterBoundaryTests(): void {
  void test("Agent Teams adapter policy classifies new application files and rejects adapter imports", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "docs-consumer-boundary-"));
    try {
      const policy = parseBoundaryFixture(
        await readFile(
          join(repositoryRoot, "architecture/foundation/source-dependencies.yaml"),
          "utf8",
        ),
      );
      const relevantBoundaryIds = new Set([
        "docs-protocol-agent-teams.adapters",
        "docs-protocol-agent-teams.application",
      ]);
      const fixturePolicy = {
        schemaVersion: 2,
        workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
        packageRoots: ["packages"],
        governedRoots: ["packages/docs-protocol-agent-teams/src/consumer-integration"],
        boundaries: policy.boundaries
          .filter(({ id }) => relevantBoundaryIds.has(id))
          .map((boundary) => ({
            ...boundary,
            entrypoints: boundary.id.endsWith(".adapters")
              ? [
                  "packages/docs-protocol-agent-teams/src/consumer-integration/adapters/node-consumer-integration-repository.ts",
                ]
              : [],
          })),
      };
      const paths = {
        applicationApi: join(
          temporaryRoot,
          "packages/docs-protocol-agent-teams/src/consumer-integration/application-api.ts",
        ),
        application: join(
          temporaryRoot,
          "packages/docs-protocol-agent-teams/src/consumer-integration/application/use-cases/new-use-case.ts",
        ),
        domain: join(
          temporaryRoot,
          "packages/docs-protocol-agent-teams/src/consumer-integration/domain/model.ts",
        ),
        generated: join(
          temporaryRoot,
          "packages/docs-protocol-agent-teams/src/consumer-integration/generated",
        ),
      };
      const adapterRoots = fixturePolicy.boundaries.find(
        ({ id }) => id === "docs-protocol-agent-teams.adapters",
      )!.roots;
      await Promise.all([
        mkdir(join(temporaryRoot, "architecture/foundation"), { recursive: true }),
        mkdir(dirname(paths.application), { recursive: true }),
        ...adapterRoots.map((root) =>
          mkdir(join(temporaryRoot, root.endsWith(".ts") ? dirname(root) : root), {
            recursive: true,
          }),
        ),
        mkdir(dirname(paths.domain), { recursive: true }),
        mkdir(paths.generated, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(temporaryRoot, "package.json"),
          `${JSON.stringify(
            {
              name: "@fixture/repository",
              version: "0.0.0",
              private: true,
              type: "module",
              packageManager: "pnpm@11.20.0",
            },
            null,
            2,
          )}\n`,
        ),
        writeFile(join(temporaryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n"),
        writeFile(
          join(temporaryRoot, "packages/docs-protocol-agent-teams/package.json"),
          `${JSON.stringify(
            {
              name: docsProtocolAgentTeamsName,
              version: "0.0.0",
              private: true,
              type: "module",
            },
            null,
            2,
          )}\n`,
        ),
        writeFile(
          join(temporaryRoot, "architecture/foundation/source-dependencies.yaml"),
          stringifyYaml(fixturePolicy, { lineWidth: 0 }),
        ),
        ...adapterRoots
          .filter((root) => root.endsWith(".ts"))
          .map((root) =>
            writeFile(join(temporaryRoot, root), "export const nodeAdapter = true;\n"),
          ),
        writeFile(paths.applicationApi, "export type { DomainMarker } from './domain/model.js';\n"),
        writeFile(paths.domain, "export interface DomainMarker { readonly id: string; }\n"),
        writeFile(
          paths.application,
          'import { nodeAdapter } from "../../adapters/node-consumer-integration-repository.js";\nexport const execute = nodeAdapter;\n',
        ),
      ]);

      const rejected = await createSourceDependenciesCapability(sourceDependencyAdapters()).run({
        consumerRoot: temporaryRoot,
        configPath: "architecture/foundation/source-dependencies.yaml",
      });
      assert.equal(rejected.outcome, "violations", JSON.stringify(rejected, null, 2));
      assert.ok(
        rejected.diagnostics.some(
          ({ location, ruleId }) =>
            ruleId === "architecture.source-dependencies.forbidden-boundary-dependency" &&
            location.path.endsWith("application/use-cases/new-use-case.ts"),
        ),
      );

      await writeFile(
        paths.application,
        'import type { DomainMarker } from "../../domain/model.js";\nexport type UseCaseMarker = DomainMarker;\n',
      );
      const accepted = await createSourceDependenciesCapability(sourceDependencyAdapters()).run({
        consumerRoot: temporaryRoot,
        configPath: "architecture/foundation/source-dependencies.yaml",
      });
      assert.equal(accepted.outcome, "passed", JSON.stringify(accepted, null, 2));
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });
}
export function registerQgrBoundaryTests(): void {
  void test("quality-gate-runner adapters may import node:util; the application layer and a removed allowance may not", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "qgr-builtin-boundary-"));
    try {
      const policy = parseBoundaryFixture(
        await readFile(
          join(repositoryRoot, "architecture/foundation/source-dependencies.yaml"),
          "utf8",
        ),
      );
      const qgr = "packages/engineering-foundation/src/capabilities/quality-gate-runner";
      const adapterFile = `${qgr}/adapters/inbound/node-test-execution/runner.ts`;
      const applicationFile = `${qgr}/application/policies/probe.ts`;
      const boundaryIds = new Set([
        "capability.quality-gate-runner.adapters",
        "capability.quality-gate-runner.application",
      ]);
      const policyWithoutUtil = (removeAdapterAllowance: boolean) => ({
        schemaVersion: 2,
        workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
        packageRoots: ["packages"],
        governedRoots: [qgr],
        boundaries: policy.boundaries
          .filter(({ id }) => boundaryIds.has(id))
          .map((boundary) => ({
            ...boundary,
            roots: boundary.roots.filter((root) => !root.endsWith(".ts")),
            allow: {
              ...boundary.allow,
              boundaries: boundary.allow.boundaries.filter((id) => boundaryIds.has(id)),
              packages: [],
              builtins:
                removeAdapterAllowance && boundary.id.endsWith(".adapters")
                  ? boundary.allow.builtins.filter((builtin) => builtin !== "node:util")
                  : boundary.allow.builtins,
            },
            entrypoints: [boundary.id.endsWith(".adapters") ? adapterFile : applicationFile],
          })),
      });
      const safeSource = "export const marker = true;\n";
      const utilSource =
        'import { types } from "node:util";\nexport const isProxy = (value: unknown) => types.isProxy(value);\n';
      await Promise.all([
        mkdir(join(temporaryRoot, "architecture/foundation"), { recursive: true }),
        mkdir(dirname(join(temporaryRoot, adapterFile)), { recursive: true }),
        mkdir(dirname(join(temporaryRoot, applicationFile)), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(temporaryRoot, "package.json"),
          `${JSON.stringify(
            {
              name: "@fixture/repository",
              version: "0.0.0",
              private: true,
              type: "module",
              packageManager: "pnpm@11.20.0",
            },
            null,
            2,
          )}\n`,
        ),
        writeFile(join(temporaryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n"),
        writeFile(
          join(temporaryRoot, "packages/engineering-foundation/package.json"),
          `${JSON.stringify(
            {
              name: "@fixture/engineering-foundation",
              version: "0.0.0",
              private: true,
              type: "module",
            },
            null,
            2,
          )}\n`,
        ),
      ]);
      const run = async ({
        adapter,
        application,
        removeAdapterAllowance = false,
      }: {
        adapter: string;
        application: string;
        removeAdapterAllowance?: boolean;
      }) => {
        await Promise.all([
          writeFile(
            join(temporaryRoot, "architecture/foundation/source-dependencies.yaml"),
            stringifyYaml(policyWithoutUtil(removeAdapterAllowance), { lineWidth: 0 }),
          ),
          writeFile(join(temporaryRoot, adapterFile), adapter),
          writeFile(join(temporaryRoot, applicationFile), application),
        ]);
        return createSourceDependenciesCapability(sourceDependencyAdapters()).run({
          consumerRoot: temporaryRoot,
          configPath: "architecture/foundation/source-dependencies.yaml",
        });
      };

      const accepted = await run({ adapter: utilSource, application: safeSource });
      assert.equal(accepted.outcome, "passed", JSON.stringify(accepted, null, 2));
      const application = await run({ adapter: safeSource, application: utilSource });
      assert.equal(application.outcome, "violations", JSON.stringify(application, null, 2));
      assert.ok(
        forbiddenAt(application, "application/policies/probe.ts"),
        JSON.stringify(application, null, 2),
      );
      const removed = await run({
        adapter: utilSource,
        application: safeSource,
        removeAdapterAllowance: true,
      });
      assert.equal(removed.outcome, "violations", JSON.stringify(removed, null, 2));
      assert.ok(
        forbiddenAt(removed, "node-test-execution/runner.ts"),
        JSON.stringify(removed, null, 2),
      );
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });
}

const forbiddenAt = (
  report: { diagnostics: readonly { location: { path: string }; ruleId: string }[] },
  suffix: string,
) =>
  report.diagnostics.some(
    ({ location, ruleId }) =>
      ruleId === "architecture.source-dependencies.forbidden-builtin-dependency" &&
      location.path.endsWith(suffix),
  );
