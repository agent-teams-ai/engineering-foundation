import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import { classifyCiShadow } from "../scripts/ci-shadow-classifier.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/ci-shadow-classifier.v1.json", import.meta.url), "utf8"));

test("shadow classifier is conservative across its closed fixture matrix", () => {
  for (const scenario of fixture.cases) {
    const result = classifyCiShadow(scenario.input);
    assert.equal(result.advisory, true, scenario.name);
    assert.equal(result.candidate, scenario.candidate, scenario.name);
    assert.equal(result.reason, scenario.reason, scenario.name);
    assert.equal(result.effectivePlan, "full", scenario.name);
  }
});

test("PR and merge-group CI never route required lanes through the shadow result", async () => {
  const source = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  assert.deepEqual(workflow.on.merge_group, {});
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === "shadow-classifier") {continue;}
    const serialized = JSON.stringify(job);
    assert.notEqual(job.needs, "shadow-classifier", name);
    assert.ok(!Array.isArray(job.needs) || !job.needs.includes("shadow-classifier"), name);
    assert.doesNotMatch(serialized, /needs\.shadow-classifier|effective-plan/u, name);
  }
});

test("both required aggregates depend on the complete Node compatibility matrix", async () => {
  const workflow = parseYaml(await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const compatibility = workflow.jobs["node26-compatibility"];
  assert.equal(compatibility.strategy["fail-fast"], false);
  assert.deepEqual(compatibility.strategy.matrix.include.map(({ lane }) => lane), [
    "node24-production-default", "node26-compatibility",
  ]);
  for (const name of ["check", "windows-check"]) {
    assert.ok(workflow.jobs[name].needs.includes("node26-compatibility"), name);
    assert.match(workflow.jobs[name].if, /always\(\)/u, name);
    assert.match(JSON.stringify(workflow.jobs[name].steps), /toJSON\(needs\)/u, name);
  }
});
