import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parse as parseYaml } from "yaml";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("partitioned coverage qualifies exact shard evidence without replacing blocking coverage", async () => {
  const ci = parseYaml(
    await readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8"),
  );
  const advisory = ci.jobs["linux-coverage-evidence-advisory"];
  assert.equal(advisory["continue-on-error"], undefined);
  assert.equal(advisory.steps.every((step) => step["continue-on-error"] === true), true);
  assert.ok(ci.jobs.check.needs.includes("linux-coverage"));
  assert.equal(ci.jobs.check.needs.includes("linux-coverage-evidence-advisory"), false);
  assert.match(advisory.if, /FOUNDATION_PARTITIONED_COVERAGE != 'off'/u);
  assert.deepEqual(advisory.needs, [
    "dependency-review",
    "linux-test-1",
    "linux-test-2",
    "linux-test-3",
    "linux-test-4",
  ]);
  const download = advisory.steps.find(({ name }) => name === "Download exact-head shard evidence");
  assert.match(download.uses, /^actions\/download-artifact@[a-f0-9]{40}$/u);
  assert.equal(download.with.pattern, "coverage-evidence-${{ github.sha }}-shard-*");
  assert.equal(download.with["merge-multiple"], false);
  assert.match(advisory.steps.at(-1).run, /--head-sha "\$\{\{ github\.sha \}\}"/u);

  for (const shardId of ["1", "2", "3", "4"]) {
    const job = ci.jobs[`linux-test-${shardId}`];
    const run = job.steps.find(({ name }) => name === "Run isolated test shard");
    const upload = job.steps.find(({ name }) => name === "Upload raw coverage evidence");
    assert.match(run.run, /FOUNDATION_PARTITIONED_COVERAGE.*off/su);
    assert.match(run.run, new RegExp(`--shards ${shardId}(?:\\n|$)`, "u"));
    assert.match(
      run.run,
      new RegExp(`--coverage-evidence-dir \\.coverage-evidence/shard-${shardId}`, "u"),
    );
    assert.match(upload.uses, /^actions\/upload-artifact@[a-f0-9]{40}$/u);
    assert.equal(upload["continue-on-error"], true);
    assert.equal(upload.with.name, `coverage-evidence-${"${{ github.sha }}"}-shard-${shardId}`);
    assert.equal(upload.with["if-no-files-found"], "error");
    assert.equal(upload.with["include-hidden-files"], true);
  }
});
