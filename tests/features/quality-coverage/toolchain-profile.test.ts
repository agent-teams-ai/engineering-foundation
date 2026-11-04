import assert from "node:assert/strict";
import test from "node:test";
import { readConfiguredQualityProfile } from "../../../packages/engineering-foundation/dist/features/quality-coverage/adapters/consumer-observations.js";

const profile = {
  schemaVersion: 5,
  budgetMs: 120000,
  sourcePolicyPath: "sources.json",
  suppressionPolicyPath: "suppressions.json",
  topologyPath: "topology.json",
  lintConfigPath: "lint.json",
  toolchainConfigPath: "toolchain.config.json",
  scripts: { fast: "fast", full: "full", scope: "scope", typed: "typed" },
};
void test("v5 derives its only compiler project set from the inert consumer toolchain config", async () => {
  const requests: string[][] = [];
  const configuration = {
    async read(root: string, path: string) {
      requests.push([root, path]);
      return { typecheck: { projects: ["tsconfig.quality.json"] } };
    },
  };
  const result = await readConfiguredQualityProfile(profile, "/consumer", configuration);
  assert.deepEqual(result.compilerProjects, ["tsconfig.quality.json"]);
  assert.deepEqual(requests, [["/consumer", "toolchain.config.json"]]);
});
void test("v5 rejects absent, empty and duplicate project authority", async () => {
  for (const config of [
    {},
    { typecheck: {} },
    { typecheck: { projects: [] } },
    { typecheck: { projects: ["a.json", "a.json"] } },
  ]) {
    await assert.rejects(
      readConfiguredQualityProfile(profile, "/consumer", {
        async read() {
          return config;
        },
      }),
    );
  }
});
