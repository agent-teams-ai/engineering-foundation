import assert from "node:assert/strict";
import test from "node:test";
import { readConfiguredQualityProfile } from "../../../packages/engineering-foundation/dist/features/quality-coverage/adapters/consumer-observations.js";

const profile = {
  schemaVersion: 4,
  sourcePolicyPath: "sources.json",
  suppressionPolicyPath: "suppressions.json",
  featureProfilePath: "features.json",
  lintConfigPath: "lint.json",
  toolchainConfigPath: "toolchain.config.json",
  scripts: { fast: "fast", full: "full", scope: "scope", typed: "typed" },
};
test("v4 derives its only compiler project set from the inert consumer toolchain config", async () => {
  const requests = [];
  const configuration = {
    async read(root, path) {
      requests.push([root, path]);
      return { typecheck: { projects: ["tsconfig.quality.json"] } };
    },
  };
  const result = await readConfiguredQualityProfile(profile, "/consumer", configuration);
  assert.deepEqual(result.compilerProjects, ["tsconfig.quality.json"]);
  assert.deepEqual(requests, [["/consumer", "toolchain.config.json"]]);
});
test("v4 rejects absent, empty and duplicate project authority", async () => {
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
