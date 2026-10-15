import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import { parse as parseYaml } from "yaml";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const executeFile = promisify(execFile);

// A child-process failure must fail the pair after its independent sibling has
// finished, while retaining each producer's status and private environment.
if (process.platform === "linux") {
  for (const phase of ["build", "test"]) {
    test(`paired Linux ${phase} drains siblings and isolates producer state`, async context => {
      const temporaryBase = join(repositoryRoot, ".cache", "ci-test-tmp");
      await mkdir(temporaryBase, { recursive: true });
      const root = await realpath(await mkdtemp(join(temporaryBase, "foundation-pair-test-")));
      context.after(() => rm(root, { recursive: true, force: true }));
      const temporary = join(root, "temporary");
      const bin = join(root, "bin");
      const output = join(root, "output");
      const log = join(root, "commands.jsonl");
      await Promise.all(["a", "b", "temporary", "bin"].map(name => mkdir(join(root, name))));
      // Extensionless runtime stubs use `require`; Node 26 would otherwise interpret them as ESM.
      await writeFile(join(bin, "package.json"), '{"type":"commonjs"}\n');
      const stub = `#!${process.execPath}\n` + String.raw`
const fs = require("node:fs");
const record = { tool: require("node:path").basename(process.argv[1]), cwd: process.cwd(), args: process.argv.slice(2),
  bun: process.env.AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE, node: process.env.AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE,
  temporary: process.env.RUNNER_TEMP, tmpdir: process.env.TMPDIR,
  tools: process.env.MANAGED_TEST_TOOLS_ROOT, managed: process.env.MANAGED_TEST_ROOT,
  node24: process.env.MANAGED_TEST_NODE24_SOURCE, node26: process.env.MANAGED_TEST_NODE26_SOURCE };
fs.appendFileSync(process.env.PAIR_TEST_LOG, JSON.stringify(record) + "\n");
if (process.cwd().endsWith("/a")) process.exit(7);
setTimeout(() => {
  fs.writeFileSync(process.env.RUNNER_TEMP + "/sibling-finished", "done");
}, 80);
`;
      await Promise.all(["bun", "node"].map(name => writeFile(join(bin, name), stub, { mode: 0o755 })));
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_SHA: "a".repeat(40),
        RUNNER_TEMP: temporary, GITHUB_OUTPUT: output, PAIR_TEST_LOG: log,
        AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: join(bin, "bun"),
        AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: join(bin, "node"),
        MANAGED_TEST_TOOLS_ROOT: "/declared-tools", MANAGED_TEST_ROOT: "/declared-managed",
        MANAGED_TEST_NODE24_SOURCE: "/declared-node24", MANAGED_TEST_NODE26_SOURCE: "/declared-node26" };
      const helper = join(repositoryRoot, "scripts", "run-ci-test-pair.mts");
      await assert.rejects(executeFile(process.execPath, [helper, phase, "3", "4"], { cwd: root, env }),
        error => error.code === 1 && /producer 3.*exited 7/u.test(error.stderr));
      assert.equal(await readFile(output, "utf8"), "first-status=7\nsecond-status=0\n");
      assert.equal(await readFile(join(temporary, "producer-4", "sibling-finished"), "utf8"), "done");
      const records = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(records.filter(record => record.cwd === join(root, "a")).length, 1);
      assert.equal(records.filter(record => record.cwd === join(root, "b")).length, phase === "build" ? 2 : 1);
      for (const record of records) {
        const first = record.cwd === join(root, "a");
        assert.equal(record.tool, phase === "build" ? "bun" : "node");
        assert.equal(record.bun, join(bin, "bun"));
        assert.equal(record.node, join(bin, "node"));
        assert.equal(record.temporary, join(temporary, first ? "producer-3" : "producer-4"));
        assert.equal(record.tmpdir, record.temporary);
        assert.equal(record.tools, first ? undefined : "/declared-tools");
        assert.equal(record.managed, first ? undefined : "/declared-managed");
        assert.equal(record.node24, first ? undefined : "/declared-node24");
        assert.equal(record.node26, first ? undefined : "/declared-node26");
        if (phase === "test") {
          assert.equal(record.args[record.args.indexOf("--shards") + 1], first ? "3" : "4");
          assert.equal(record.args[record.args.indexOf("--head-sha") + 1], "a".repeat(40));
        }
      }
      if (phase === "build") {
        assert.deepEqual(
          new Set(records.filter(record => record.cwd === join(root, "b")).map(record => JSON.stringify(record.args))),
          new Set([
            JSON.stringify(["tools/dev.mts", "install"]),
            JSON.stringify(["tools/dev.mts", "build"]),
          ]),
        );
      }
      const before = await readFile(log, "utf8");
      await assert.rejects(executeFile(process.execPath, [helper, phase, "3", "5"], { cwd: root, env }), /Usage/u);
      assert.equal(await readFile(log, "utf8"), before, "invalid pair must not launch a producer");
    });
  }
}

test("partitioned coverage is the fail-closed blocking coverage authority", async () => {
  const ci = parseYaml(
    await readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8"),
  );
  const codeql = parseYaml(
    await readFile(join(repositoryRoot, ".github", "workflows", "codeql.yml"), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "tests", "manifests", "coverage.v1.json"), "utf8"),
  );
  assert.deepEqual(manifest.evidenceThresholds, { lines: 70, branches: 77, functions: 78 });
  const coverage = ci.jobs["linux-coverage"];
  assert.equal(ci.jobs["linux-coverage-evidence-advisory"], undefined);
  assert.equal(coverage.steps.every((step) => step["continue-on-error"] === undefined), true);
  assert.ok(ci.jobs.check.needs.includes("linux-coverage"));
  assert.equal(JSON.stringify(ci).includes("FOUNDATION_PARTITIONED_COVERAGE"), false);
  const fullRequestCondition =
    "${{ github.event_name != 'pull_request' || (github.event.label.name == 'ci:full' || startsWith(github.event.label.name, 'ci:full:')) }}";
  assert.deepEqual(ci.on.pull_request.types, ["labeled"]);
  assert.deepEqual(codeql.on.pull_request.types, [
    "opened", "synchronize", "reopened", "ready_for_review",
  ]);
  assert.equal(ci.jobs["draft-fast"], undefined);
  assert.equal(codeql.jobs.analyze.if,
    "${{ github.event_name != 'pull_request' || github.event.pull_request.draft == false }}");
  for (const [jobId, job] of Object.entries(ci.jobs)) {
    if (jobId !== "dependency-review") {
      const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
      assert.ok(needs.includes("dependency-review"), `${jobId} bypasses dependency review`);
    }
    const aggregate = ["check", "windows-check", "macos-qualification"].includes(jobId);
    const expected = jobId === "full-ci" ? "${{ always() }}" : aggregate
      ? "${{ always() && (github.event_name != 'pull_request' || (github.event.label.name == 'ci:full' || startsWith(github.event.label.name, 'ci:full:'))) }}"
      : fullRequestCondition;
    assert.equal(job.if, jobId === "dependency-review" ? undefined : expected,
      `${jobId} must preserve unconditional dependency review or explicit full admission`);
  }
  assert.deepEqual(coverage.needs, [
    "dependency-review",
    "linux-tests",
  ]);
  const download = coverage.steps.find(({ name }) => name === "Download exact-head shard evidence");
  assert.match(download.uses, /^actions\/download-artifact@[a-f0-9]{40}$/u);
  assert.equal(download.with.pattern, "coverage-evidence-${{ github.sha }}-shard-*");
  assert.equal(download.with["merge-multiple"], false);
  assert.match(coverage.steps.at(-1).run, /--head-sha "\$\{\{ github\.sha \}\}"/u);
  assert.equal(coverage.steps.some(({ run }) => /test:coverage:built/u.test(run ?? "")), false);

  const producer = ci.jobs["linux-tests"];
  assert.equal(producer.strategy["fail-fast"], false);
  assert.equal(producer.strategy["max-parallel"], undefined);
  const pairs = producer.strategy.matrix.pair;
  assert.deepEqual(pairs.map(pair => [pair.first, pair.second]),
    [["1", "2"], ["3", "4"], ["5", "6"], ["7", "8"]]);
  assert.deepEqual(pairs.flatMap(pair => [pair.first, pair.second]).toSorted(),
    ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.equal(producer.name, "linux-tests-${{ matrix.pair.first }}-${{ matrix.pair.second }}");
  assert.equal(producer["continue-on-error"], undefined);
  assert.equal(producer.env.NODE_DISABLE_COMPILE_CACHE, "1");
  assert.equal(producer.env.FIRST_SHARD, "${{ matrix.pair.first }}");
  assert.equal(producer.env.SECOND_SHARD, "${{ matrix.pair.second }}");
  const checkouts = producer.steps.filter(step => step.uses?.startsWith("actions/checkout@"));
  assert.deepEqual(checkouts.map(step => step.with.path), ["a", "b"]);
  for (const checkout of checkouts) {
    assert.equal(checkout.with["fetch-depth"], 0);
    assert.equal(checkout.with["persist-credentials"], false);
  }
  const setup = producer.steps.find(step => step.uses?.startsWith("oven-sh/setup-bun@"));
  assert.equal(setup.uses, "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
  assert.deepEqual(setup.with, { "bun-version": "1.4.3" });
  const build = producer.steps.find(step => step.name === "Build both isolated producers");
  assert.equal(build.run, 'node a/scripts/run-ci-test-pair.mts build "$FIRST_SHARD" "$SECOND_SHARD"');
  const run = producer.steps.find(step => step.id === "test-pair");
  assert.equal(run.run, 'node a/scripts/run-ci-test-pair.mts test "$FIRST_SHARD" "$SECOND_SHARD"');
  assert.equal(build.env.AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE,
    "${{ steps.setup-bun.outputs.bun-path }}");
  assert.equal(run.env.AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE,
    "${{ steps.setup-bun.outputs.bun-path }}");
  assert.equal(run["continue-on-error"], undefined);
  for (const [key, root] of [["first", "a"], ["second", "b"]]) {
    const identity = "${{ matrix.pair." + key + " }}";
    const upload = producer.steps.find(step => step.name === `Upload ${key} raw coverage evidence`);
    assert.match(upload.uses, /^actions\/upload-artifact@[a-f0-9]{40}$/u);
    assert.equal(upload["continue-on-error"], undefined);
    assert.equal(upload.if, "${{ always() && steps.test-pair.outputs." + key + "-status == '0' }}");
    assert.equal(upload.with.name, "coverage-evidence-${{ github.sha }}-shard-" + identity);
    assert.equal(upload.with.path, root + "/.coverage-evidence/shard-" + identity);
    assert.equal(upload.with["if-no-files-found"], "error");
    assert.equal(upload.with["include-hidden-files"], true);
    assert.equal(upload.with.overwrite, true);
  }
  const managed = producer.steps.filter(step => step.name?.includes("pinned"));
  assert.equal(managed.length, 3);
  for (const step of managed) { assert.equal(step.if, "${{ matrix.pair.second == '4' }}"); }
  const provision = managed.find(step => step.run?.includes("provision-managed-test-tools"));
  assert.equal(provision["working-directory"], "b");
  assert.equal(provision.env.RUNNER_TEMP, "${{ runner.temp }}/producer-4");
  // Managed generation2 tuples stay Node 24.21.0 / 26.10.0; the repository default comes from .node-version.
  const node24 = producer.steps.find(step => step.with?.["node-version"] === "24.21.0");
  // Node 24 is provisioned for every pair: shards 1 and 2 run legacy generation2 suites through it.
  assert.equal(node24.if, undefined);
  const node24Capture = producer.steps.find(step => /PACK_TEST_GENERATION2_NODE=/u.test(step.run ?? ""));
  assert.equal(node24Capture.if, undefined);
  assert.ok(producer.steps.indexOf(node24) < producer.steps.indexOf(node24Capture));
  const node26 = producer.steps.find(step => step.with?.["node-version"] === "26.10.0");
  assert.equal(node26.if, "${{ matrix.pair.second == '4' }}");
  const defaultNode = producer.steps.find(step => step.with?.["node-version-file"]);
  assert.equal(defaultNode.with["node-version-file"], "a/.node-version");
  assert.equal(defaultNode.with.cache, undefined);
  assert.equal(defaultNode.with["cache-dependency-path"], undefined);
  assert.ok(producer.steps.indexOf(node24) < producer.steps.indexOf(node26));
  assert.ok(producer.steps.indexOf(node26) < producer.steps.indexOf(defaultNode));


});

test("every CI job that reaches generation2 pack-test binds an explicit Node 24 before the Node 26 default", async () => {
  const ci = parseYaml(await readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8"));
  for (const jobId of ["linux-package", "linux-registry", "windows-package", "macos-package"]) {
    const steps = ci.jobs[jobId].steps;
    const node24 = steps.findIndex(step => step.uses?.startsWith("actions/setup-node@") && step.with?.["node-version"] === "24.21.0");
    const capture = steps.findIndex(step => /PACK_TEST_GENERATION2_NODE=/u.test(step.run ?? ""));
    const defaultNode = steps.findIndex(step => step.uses?.startsWith("actions/setup-node@") && step.with?.["node-version-file"] === ".node-version");
    assert.ok(node24 >= 0 && capture > node24 && defaultNode > capture, `${jobId}: Node 24 setup, capture, then default Node`);
    assert.match(steps[capture].run, /command -v node|Get-Command node/u, jobId);
  }
});

test("Node compatibility uses a clean pnpm profile projection without changing the Bun source root", async () => {
  const ci = parseYaml(await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"));
  const steps = ci.jobs["node26-compatibility"].steps;
  const compatibilityCapture = steps.findIndex(step => /COMPAT_NODE_EXECUTABLE=/u.test(step.run ?? ""));
  const qualificationNodeSetup = steps.findIndex(step =>
    step.uses?.startsWith("actions/setup-node@") && step.with?.["node-version-file"] === ".node-version");
  const qualificationCapture = steps.findIndex(step =>
    /AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE=/u.test(step.run ?? ""));
  const restoredCompatibilitySetup = steps.findLastIndex(step =>
    step.uses?.startsWith("actions/setup-node@") && step.with?.["node-version"] === "${{ matrix.node-version }}");
  assert.ok(compatibilityCapture >= 0 && qualificationNodeSetup > compatibilityCapture &&
    qualificationCapture > qualificationNodeSetup && restoredCompatibilitySetup > qualificationCapture);
  const install = steps.find(step => step.run === "node tools/dev.mts --profile node install");
  assert.deepEqual(install.env, {
    AGENT_TEAMS_FOUNDATION_SOURCE_SHA: "${{ github.sha }}",
    AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT:
      "${{ steps.setup-pnpm.outputs.bin-dest }}/pnpm${{ runner.os == \"Windows\" && \".exe\" || \"\" }}"
  });
  const pnpmSetup = steps.find(step => step.uses?.startsWith("pnpm/setup@"));
  assert.equal(pnpmSetup.uses, "pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b");
  assert.deepEqual(pnpmSetup.with, { version: "11.20.0", install: false });
  for (const step of steps.filter(candidate =>
    candidate.run === "pnpm dependencies:peers:check" ||
    candidate.run === "pnpm rebuild" ||
    candidate.run === "pnpm node-compatibility:qualification" ||
    candidate.run?.startsWith("node --test --test-concurrency=1"))) {
    assert.equal(step["working-directory"], ".worker-tmp/profiles/node-${{ github.sha }}");
  }
  assert.equal(steps.some(step => step.run === "pnpm install --frozen-lockfile --ignore-scripts --engine-strict"), false);
  assert.equal(steps.some(step => step.uses?.startsWith("oven-sh/setup-bun@")), false);
});

test("ordinary workflows pin Bun 1.4.3 and retain explicit pnpm tools without mixing graphs", async () => {
  const workflows = await Promise.all(["ci.yml", "pr-feedback.yml", "performance.yml"].map(async name =>
    parseYaml(await readFile(join(repositoryRoot, ".github/workflows", name), "utf8"))));
  for (const workflow of workflows) {
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      const steps = job.steps ?? [];
      const installsBunGraph = steps.some(step => step.run === "bun tools/dev.mts install");
      const setupBun = steps.find(step => step.uses?.startsWith("oven-sh/setup-bun@"));
      if (installsBunGraph || setupBun !== undefined) {
        assert.equal(setupBun?.uses,
          "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6", `${workflow.name}/${jobId}`);
        assert.deepEqual(setupBun?.with, { "bun-version": "1.4.3" }, `${workflow.name}/${jobId}`);
      }
      const pnpmSetup = steps.find(step => step.uses?.startsWith("pnpm/setup@"));
      if (pnpmSetup !== undefined) {
        assert.equal(pnpmSetup.uses, "pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b",
          `${workflow.name}/${jobId}`);
        assert.deepEqual(pnpmSetup.with, { version: "11.20.0", install: false },
          `${workflow.name}/${jobId}`);
      }
      if (installsBunGraph) {
        assert.equal(steps.some(step => step.with?.cache === "pnpm"), false,
          `${workflow.name}/${jobId} must keep Bun and pnpm dependency caches separate`);
      }
    }
  }
});

test("Automatic PR feedback checks the committed delta independently of full qualification", async () => {
  const ci = parseYaml(
    await readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8"),
  );
  const preliminary = parseYaml(
    await readFile(join(repositoryRoot, ".github", "workflows", "pr-feedback.yml"), "utf8"),
  );
  assert.notEqual(preliminary.name, ci.name, "Feedback must not change the full CI run conclusion");
  assert.equal(ci.jobs["pr-feedback"], undefined);
  assert.deepEqual(preliminary.permissions, { contents: "read" });
  assert.deepEqual(preliminary.on.pull_request.types, ["opened", "synchronize", "reopened", "ready_for_review"]);
  const feedback = preliminary.jobs["pr-feedback"];
  assert.ok(feedback, "All pull requests need a preliminary feedback lane");
  assert.equal(feedback.if, undefined, "Draft and ordinary updates receive fast feedback");
  const security = preliminary.jobs["dependency-review"];
  assert.ok(security, "Feedback needs its own declared blocking Dependency Review job");
  assert.equal(security.if, undefined);
  assert.equal(security["continue-on-error"], undefined);
  assert.equal(feedback.needs, "dependency-review");
  const review = security.steps.find(({ uses }) =>
    uses?.startsWith("actions/dependency-review-action@"));
  const declaredReview = ci.jobs["dependency-review"].steps.find(({ uses }) =>
    uses?.startsWith("actions/dependency-review-action@"));
  assert.deepEqual(review, declaredReview,
    "Feedback Dependency Review must preserve the declared blocking security semantics");
  const installIndex = feedback.steps.findIndex(({ run }) =>
    run === "bun tools/dev.mts install");
  assert.ok(installIndex > 0, "Feedback must install pinned dependencies after checkout");
  const setupBun = feedback.steps.find(step => step.uses?.startsWith("oven-sh/setup-bun@"));
  assert.ok(feedback.steps.indexOf(setupBun) < installIndex);
  assert.equal(setupBun.uses,
    "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
  assert.deepEqual(setupBun.with, { "bun-version": "1.4.3" });
  assert.equal(feedback["timeout-minutes"], 10);
  const checkout = feedback.steps.find(({ uses }) => uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with["fetch-depth"], 0, "PR base and merge-base history must be available");
  assert.equal(checkout.with["persist-credentials"], false);
  const changed = feedback.steps.find(({ name }) => name === "Check the complete pull-request delta");
  assert.deepEqual(changed.env, {
    FOUNDATION_PR_BASE_SHA: "${{ github.event.pull_request.base.sha }}",
  });
  assert.equal(changed.run,
    'bun packages/engineering-foundation/dist/cli.js agent-workflow changed --consumer . --base "$FOUNDATION_PR_BASE_SHA"');
  assert.equal(changed["continue-on-error"], undefined);
  assert.equal(preliminary.concurrency.group.replace(/\s+/gu, " "),
    "${{ format('foundation-feedback-{0}', github.event.pull_request.number) }}",
    "Feedback cancellation must stay separate from full qualification");
  assert.equal(preliminary.concurrency["cancel-in-progress"], true);
  const full = ci.jobs["full-ci"];
  const nativeAggregates = ["check", "windows-check", "macos-qualification"];
  const mandatoryUnion = new Set(nativeAggregates.flatMap(id => ci.jobs[id].needs));
  assert.deepEqual([...full.needs].toSorted(), [...mandatoryUnion].toSorted(),
    "The parallel gate must require the entire mandatory native union, including future lanes");
  assert.equal(new Set(full.needs).size, full.needs.length);
  for (const id of nativeAggregates) {
    assert.equal(full.needs.includes(id), false, "full-ci must not extend the aggregate critical path");
    assert.equal(ci.jobs[id].name,
      "${{ (github.event_name != 'pull_request' || (github.event.label.name == 'ci:full' || startsWith(github.event.label.name, 'ci:full:'))) && '" + id + "' || 'ci-not-requested-" + id + "' }}",
      `${id}: unrelated labels must not emit skipped original required contexts`);
    assert.equal(ci.jobs[id]["timeout-minutes"], id === "macos-qualification" ? 5 : 2,
      `${id}: preserve the original native aggregate timeout`);
    assert.equal(ci.jobs[id].steps[0].uses,
      "re-actors/alls-green@a638d6464689bbb24c325bb3fe9404d63a913030");
    assert.deepEqual(ci.jobs[id].steps[0].with, { jobs: "${{ toJSON(needs) }}" });
  }
  assert.equal(full.if, "${{ always() }}");
  assert.equal(full.name,
    "${{ (github.event_name != 'pull_request' || (github.event.label.name == 'ci:full' || startsWith(github.event.label.name, 'ci:full:'))) && 'full-ci' || 'ci-not-requested' }}",
    "Unrelated labels must never emit a skipped/neutral check named full-ci");
  assert.deepEqual(full.permissions, {});
  assert.equal(full["timeout-minutes"], 1);
  assert.equal(full.steps[0].if,
    "${{ github.event_name != 'pull_request' || (github.event.label.name == 'ci:full' || startsWith(github.event.label.name, 'ci:full:')) }}");
  assert.equal(full.steps[0].uses, "re-actors/alls-green@a638d6464689bbb24c325bb3fe9404d63a913030");
  assert.deepEqual(full.steps[0].with, { jobs: "${{ toJSON(needs) }}" },
    "No skipped, neutral or failed prerequisite is allowed");
  assert.match(ci["run-name"], /format\('Full CI #\{0\} @\{1\} on \{2\}', github.event.pull_request.number, github.event.pull_request.head.sha, github.event.pull_request.base.sha\)/u);
  assert.match(ci.concurrency.group, /ci:full.*format\('foundation-pr-\{0\}-\{1\}-\{2\}', github.event.pull_request.number, github.event.pull_request.head.sha, github.event.pull_request.base.sha\)/su);
  assert.match(ci.concurrency.group, /format\('foundation-ci-unrequested-\{0\}', github.run_id\)/u);
  assert.equal(ci.on.pull_request_target, undefined);
  assert.equal(ci.on.workflow_run, undefined);
  for (const [jobId, job] of Object.entries(ci.jobs)) {
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
    assert.equal(needs.includes("pr-feedback"), false,
      `${jobId} must not make preliminary feedback a full-qualification prerequisite`);
  }
  for (const requiredJob of ["check", "windows-check", "macos-qualification"]) {
    assert.ok(ci.jobs[requiredJob], `${requiredJob} remains a full qualification authority`);
  }
});

// Enabling cache in raw producers can silently reduce precise V8 coverage.
test("CI cannot enable an unqualified compile cache and raw coverage disables it", async () => {
  const ci = parseYaml(await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"));
  const enabled = Object.entries(ci.jobs).flatMap(([id, job]) =>
    job.steps.flatMap(step => step.env?.NODE_COMPILE_CACHE === undefined ? [] : [{ id, step }]));
  assert.deepEqual(enabled, []);
  for (const [id, job] of Object.entries(ci.jobs)) {
    assert.equal(job.env?.NODE_COMPILE_CACHE, undefined, `${id} cannot enable cache for unqualified suites`);
  }
});
