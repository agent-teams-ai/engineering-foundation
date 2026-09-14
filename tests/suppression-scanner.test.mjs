import assert from "node:assert/strict";
import test from "node:test";
import { OxcSuppressionScanner } from "../packages/engineering-foundation/dist/capabilities/suppression-governance/adapters/outbound/oxc/oxc-suppression-scanner.js";
import { evaluateSuppressionGovernance } from "../packages/engineering-foundation/dist/capabilities/suppression-governance/application/policies/evaluate-suppression-governance.js";

function scan(comment) {
  const result = new OxcSuppressionScanner().scan({
    path: "src/example.ts", source: `${comment}\nexport const value = 1;\n`,
  });
  assert.equal(result.parseErrorCount, 0);
  return result;
}

function evaluate(comment, waivers = []) {
  return evaluateSuppressionGovernance({
    policy: { governedRoots: ["src"], nonWaivableRulePrefixes: [], waivers },
    scans: [scan(comment)], today: "2026-09-14",
  });
}

test("lint explanations do not become rules for any suppression form", () => {
  for (const tool of ["oxlint", "eslint"]) {
    for (const form of ["disable", "disable-line", "disable-next-line"]) {
      for (const reason of ["-- human reason, no-alert", "--- reason", "-- first line\nsecond line"]) {
        const result = scan(`/* ${tool}-${form} no-console, typescript/no-explicit-any, no-console ${reason} */`);
        assert.deepEqual(result.directives, [{
          kind: `${tool}-${form}`, path: "src/example.ts", line: 1, column: 1,
          scope: form === "disable" ? "file" : "line",
          rules: ["no-console", "typescript/no-explicit-any"],
        }]);
        assert.deepEqual(scan(`/* ${tool}-${form} ${reason} */`).directives[0].rules, []);
      }
    }
  }
});

test("reason separators follow the selected linter syntax", () => {
  for (const comment of [
    "// oxlint-disable-next-line no-console-- reason",
    "// oxlint-disable-next-line no-console - reason",
    "// oxlint-disable-next-line no-console --reason",
    "// eslint-disable-next-line no-console -- reason",
  ]) {
    assert.deepEqual(scan(comment).directives[0].rules, ["no-console"]);
  }
  for (const rule of ["plugin/no-console--suffix", "no-console--reason", "no-console-reason"]) {
    assert.deepEqual(scan(`// eslint-disable-next-line ${rule}`).directives[0].rules, [rule]);
  }
  assert.deepEqual(scan("// oxlint-disable-next-line plugin/no-console-reason").directives[0].rules,
    ["plugin/no-console-reason"]);
  assert.deepEqual(scan('// explanation: oxlint-disable-next-line no-console -- reason').directives, []);
  assert.deepEqual(scan('export const text = "oxlint-disable-next-line no-console -- reason";').directives, []);
  assert.deepEqual(scan("// ast-grep-ignore: no-console -- reason").directives[0].rules,
    ["--", "no-console", "reason"]);
});

test("a human explanation preserves exact waiver matching and actual enforcement", () => {
  const comment = "// oxlint-disable-next-line no-console -- human reason, security.secret";
  const waiver = {
    id: "TEST-1", path: "src/example.ts", line: 1, directive: "oxlint-disable-next-line",
    rules: ["no-console"], owner: "test", reason: "Exact scanner regression",
    createdOn: "2026-09-14", expiresOn: "2026-09-15", decisionRef: "ADR-TEST",
  };
  assert.deepEqual(evaluate(comment, [waiver]), []);
  const [unregistered] = evaluate(comment);
  assert.equal(unregistered.ruleId, "quality.suppression-governance.unregistered-suppression");
  assert.deepEqual(unregistered.evidence, [{ kind: "rule", value: "no-console" }]);
  assert.equal(evaluate(comment, [{ ...waiver, rules: ["no-alert"] }])[0].ruleId,
    "quality.suppression-governance.waiver-mismatch");
  for (const [directive, expected] of [
    ["oxlint-disable-next-line -- reason", "unscoped-suppression"],
    ["oxlint-disable -- reason", "broad-suppression"],
    ["oxlint-disable no-console -- reason", "broad-suppression"],
    ["eslint-disable-next-line -- reason", "legacy-suppression"],
    ["oxlint-disable-next-line security.secret -- reason", "protected-rule-suppression"],
  ]) {
    assert.equal(evaluate(`// ${directive}`)[0].ruleId, `quality.suppression-governance.${expected}`);
  }
});
