import assert from "node:assert/strict";
import test from "node:test";
import { validateFeatureModules } from "../scripts/check-feature-modules.mjs";

// Execute the unchanged repository owner/layer guard over the actual source.
test("capability adapters mediate reporting through their own application policies", async () => {
  const result = await validateFeatureModules();
  assert.equal(result.modules, 6);
  assert.deepEqual(result.problems.filter(({ code }) =>
    ["input-error", "source-policy", "unowned-source", "unowned-edge"].includes(code)
  ), []);
  assert.deepEqual(result.problems.filter(({ message }) =>
    message.startsWith("packages/engineering-foundation/src/capabilities/") &&
    message.includes(" -> packages/engineering-foundation/src/features/validation-reporting/") &&
    message.includes("adapters cannot import application")
  ), []);
});
