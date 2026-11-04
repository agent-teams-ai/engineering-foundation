import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { runFoundationCheck } from "../packages/engineering-foundation/dist/composition/foundation-check.js";
import { PnpmWorkspaceInventoryReader } from "../packages/engineering-foundation/dist/workspace-inventory/adapters/outbound/pnpm/pnpm-workspace-inventory-reader.js";
import { createWorkspaceInventoryReader } from "../packages/engineering-foundation/dist/workspace-inventory/module.js";
import { withPublicApiFixture } from "./support/capability-fixtures.mjs";

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function prepareGrowthInputs(root: string): Promise<void> {
  const configPath = join(root, "architecture/foundation/public-api-compatibility.yaml");
  const config = record(parse(await readFile(configPath, "utf8")));
  await cp("tests/fixtures/governance-architecture-decisions/valid", root, { recursive: true });
  await cp(
    "tests/fixtures/governance-architecture-decisions/valid/governance-architecture-decisions.yaml",
    join(root, "architecture/foundation/governance-architecture-decisions.yaml"),
  );
  config.schemaVersion = 2;
  config.governanceConfigPath = "architecture/foundation/governance-architecture-decisions.yaml";
  config.sdkGrowth = {
    contractRevision: "foundation:sdk-growth:c0:5",
    policyVersion: "foundation:sdk-growth:policy:1",
    comparison: {
      trustedBasePath: "evidence/base.json",
      released: [
        {
          packageName: "@fixture/public-api",
          kind: "released",
          observationPath: "evidence/released.json",
        },
      ],
    },
    decisionsPath: "evidence/decisions.json",
    reportPath: "reports/sdk.json",
  };
  await writeFile(configPath, stringify(config));
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture-root", private: true, version: "1.0.0" }),
  );
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await mkdir(join(root, "reports"));
  await mkdir(join(root, "evidence"));
  await writeFile(join(root, "evidence/decisions.json"), "[]");
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "config", "core.autocrlf", "false"]);
  await writeFile(
    join(root, "packages/library/package.json"),
    JSON.stringify({
      name: "@fixture/public-api",
      version: "1.2.3",
      type: "module",
      types: "./dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.d.ts" } },
    }),
  );
  await mkdir(join(root, "packages/helper"));
  await writeFile(
    join(root, "packages/helper/package.json"),
    JSON.stringify({ name: "@fixture/helper", private: true, version: "1.0.0" }),
  );
  commitPackages(root);
}

function commitPackages(root: string): void {
  execFileSync("git", ["-C", root, "add", "packages"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
}

async function addPackage(root: string): Promise<void> {
  await mkdir(join(root, "packages/added"));
  await writeFile(
    join(root, "packages/added/package.json"),
    JSON.stringify({ name: "@fixture/added", version: "1.0.0" }),
  );
}

async function changeManifest(
  root: string,
  change: "module-type" | "condition-order",
): Promise<void> {
  const path = join(root, "packages/library/package.json");
  const manifest = record(JSON.parse(await readFile(path, "utf8")));
  if (change === "module-type") {
    manifest.type = "commonjs";
  } else {
    record(manifest.exports)["."] = { default: "./dist/index.d.ts", types: "./dist/index.d.ts" };
  }
  await writeFile(path, JSON.stringify(manifest));
  // Identity reads see a clean current commit. Only the stale policy facts can
  // expose a discovery-to-identity mismatch; a dirty-tree check is insufficient.
  commitPackages(root);
}

const changes = [
  { name: "a new workspace package after discovery", afterRead: 1, change: addPackage },
  { name: "a new workspace package after initial binding", afterRead: 2, change: addPackage },
  {
    name: "same-membership module-type drift before initial identity",
    afterRead: 1,
    change: (root: string) => changeManifest(root, "module-type"),
  },
  {
    name: "reordered export conditions before initial identity",
    afterRead: 1,
    change: (root: string) => changeManifest(root, "condition-order"),
  },
  {
    name: "a renamed selected package before final identity",
    afterRead: 2,
    change: (root: string) => rename(join(root, "packages/helper"), join(root, "packages/renamed")),
  },
  {
    name: "a removed selected package before final identity",
    afterRead: 2,
    change: (root: string) => rm(join(root, "packages/helper"), { recursive: true }),
  },
] as const;

export function registerGrowthInputStabilityCases(): void {
  for (const change of changes) {
    void test(`public SDK check refuses ${change.name} without replacing prior evidence`, async (t) => {
      await withPublicApiFixture(async (root: string) => {
        await prepareGrowthInputs(root);
        const prior = "retained prior execution evidence\n";
        await writeFile(join(root, "reports/sdk.json"), prior);
        const realReader = createWorkspaceInventoryReader();
        const read = realReader.read.bind(realReader);
        let reads = 0;
        t.mock.method(
          PnpmWorkspaceInventoryReader.prototype,
          "read",
          async (...args: Parameters<typeof read>) => {
            const inventory = await read(...args);
            if (args[0] === root && ++reads === change.afterRead) {
              await change.change(root);
            }
            return inventory;
          },
        );
        const report = await runFoundationCheck({
          consumerRoot: root,
          foundationVersion: "fixture",
        });
        assert.ok(reads > change.afterRead);
        assert.equal(await readFile(join(root, "reports/sdk.json"), "utf8"), prior);
        assert.equal(report.outcome, "failed", JSON.stringify(report));
        assert.ok(report.capabilities.every((capability) => capability.diagnostics.length === 0));
      });
    });
  }

  for (const interruption of ["cancellation", "read-failure"] as const) {
    void test(`public SDK check preserves prior evidence on final workspace ${interruption}`, async (t) => {
      await withPublicApiFixture(async (root: string) => {
        await prepareGrowthInputs(root);
        const prior = "retained prior execution evidence\n";
        await writeFile(join(root, "reports/sdk.json"), prior);
        const controller = new AbortController();
        const realReader = createWorkspaceInventoryReader();
        const read = realReader.read.bind(realReader);
        let reads = 0;
        t.mock.method(
          PnpmWorkspaceInventoryReader.prototype,
          "read",
          async (...args: Parameters<typeof read>) => {
            const inventory = await read(...args);
            if (args[0] === root && ++reads === 3) {
              if (interruption === "read-failure") {
                throw new Error("workspace observation unavailable");
              }
              controller.abort();
            }
            return inventory;
          },
        );
        const report = await runFoundationCheck({
          consumerRoot: root,
          foundationVersion: "fixture",
          signal: controller.signal,
        });
        assert.equal(reads, 3);
        assert.equal(report.outcome, interruption === "cancellation" ? "cancelled" : "failed");
        assert.equal(await readFile(join(root, "reports/sdk.json"), "utf8"), prior);
      });
    });
  }

  void test("public SDK check keeps unrelated untracked files and inventory enumeration outside growth identity", async (t) => {
    await withPublicApiFixture(async (root: string) => {
      await prepareGrowthInputs(root);
      const realReader = createWorkspaceInventoryReader();
      const read = realReader.read.bind(realReader);
      let reads = 0;
      t.mock.method(
        PnpmWorkspaceInventoryReader.prototype,
        "read",
        async (...args: Parameters<typeof read>) => {
          const inventory = await read(...args);
          if (args[0] === root) {
            reads += 1;
            if (reads === 1) {
              await writeFile(join(root, "unrelated-notes.txt"), "outside package inputs\n");
            }
            if (reads % 2 === 0) {
              return { ...inventory, packages: inventory.packages.toReversed() };
            }
          }
          return inventory;
        },
      );
      const report = await runFoundationCheck({ consumerRoot: root, foundationVersion: "fixture" });
      assert.equal(reads, 4);
      assert.equal(report.outcome, "invalid-input", JSON.stringify(report));
      assert.equal(report.capabilities[0]?.problem?.code, "SDK_GROWTH_EVIDENCE_INCOMPLETE");
      assert.equal(
        record(JSON.parse(await readFile(join(root, "reports/sdk.json"), "utf8"))).verdict,
        "incomplete",
      );
    });
  });
}
