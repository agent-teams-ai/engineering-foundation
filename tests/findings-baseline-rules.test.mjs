import assert from "node:assert/strict";
import test from "node:test";
import { FINDINGS_BASELINE_RULES_BY_ID } from "../packages/engineering-foundation/dist/capabilities/findings-baseline/module.js";
import { CAPABILITY_MODULES } from "../packages/engineering-foundation/dist/composition/capability-modules.js";
import { RULE_REGISTRY } from "../packages/engineering-foundation/dist/composition/rule-registry.js";

test("the findings baseline is a command module: explained, but not a check capability", () => {
  assert.ok(FINDINGS_BASELINE_RULES_BY_ID.size > 0);
  assert.equal(CAPABILITY_MODULES.some(({ definition }) => definition.id === "quality.findings-baseline"), false);
  const checkRules = CAPABILITY_MODULES.reduce((count, { rules }) => count + rules.size, 0);
  assert.equal(RULE_REGISTRY.size, checkRules + FINDINGS_BASELINE_RULES_BY_ID.size);
  for (const [ruleId, metadata] of FINDINGS_BASELINE_RULES_BY_ID) {
    assert.equal(metadata.id, ruleId);
    assert.equal(RULE_REGISTRY.get(ruleId), metadata);
  }
});
