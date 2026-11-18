import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const integrityPresetPath = fileURLToPath(
  new URL("../presets/oxlint/test-integrity.json", import.meta.url),
);

void test("test-integrity preset selects narrow external rules without loading plugins", () => {
  const overlay: unknown = JSON.parse(readFileSync(integrityPresetPath, "utf8"));
  assert.deepEqual(overlay, {
    rules: {
      "landmines-testing/no-fixed-sleep": "error",
      "landmines-testing/no-flake-masking": "error",
    },
  });
});
