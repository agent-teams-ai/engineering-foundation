import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { nativeMergeProfile } from "../../scripts/merge-reviewed-pr.mts";
import { resolveQualificationExecutables } from "../../tools/executable-policy.mts";
import { pnpmPortableName, resolvePnpmInvocation } from "../../tools/pnpm-command.mts";
const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const pnpmSetup = "pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b";

export async function ownedTemporaryRoot(prefix: string): Promise<string> {
  const parent = join(repositoryRoot, ".worker-tmp/profiles");
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, prefix));
}

interface Workflow {
  readonly env?: Record<string, unknown>;
  readonly jobs: Record<
    string,
    | {
        readonly env?: Record<string, unknown>;
        readonly steps: readonly Record<string, unknown>[];
        readonly strategy?: { readonly matrix?: Record<string, readonly unknown[]> };
      }
    | undefined
  >;
}

export async function workflow(name: string): Promise<Workflow> {
  const parsed: unknown = parseYaml(
    await readFile(join(repositoryRoot, ".github/workflows", name), "utf8"),
  );
  assert.ok(record(parsed) && record(parsed.jobs));
  // Reusable workflow jobs omit steps; existing callers observe an empty step list.
  const value = {
    ...parsed,
    jobs: Object.fromEntries(
      Object.entries(parsed.jobs).map(([id, job]) => [
        id,
        record(job) && job.steps === undefined ? { ...job, steps: [] } : job,
      ]),
    ),
  };
  assert.ok(isWorkflow(value));
  return value;
}

void test("job TMPDIR uses valid runtime placement with finite named paths", async () => {
  const ci = await workflow("ci.yml");
  for (const id of [
    "node26-compatibility",
    "linux-package",
    "linux-registry",
    "linux-published",
    "windows-package",
    "windows-registry",
    "windows-published",
    "macos-package",
  ]) {
    assert.equal(ci.jobs[id]?.env?.["TMPDIR"], undefined, id);
    const temporarySetup = ci.jobs[id]?.steps.find(
      (step) =>
        typeof step["run"] === "string" &&
        (step["run"].includes('tmpdir="${RUNNER_TEMP}/') ||
          step["run"].includes("$tmpdir = Join-Path $env:RUNNER_TEMP")),
    );
    assert.ok(temporarySetup, id);
    assert.ok(temporarySetup["shell"] === "bash" || temporarySetup["shell"] === "pwsh", id);
  }
  const source = await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  assert.doesNotMatch(source, /^\s+TMPDIR: \$\{\{ runner\.temp \}\}\s*$/mu);
  assert.match(source, /TMPDIR: \$\{\{ runner\.temp \}\}\/producer-4/u);
});

function runs(step: Record<string, unknown>, command: string): boolean {
  return step["run"] === command;
}

export function stepWith(step: Record<string, unknown>): Record<string, unknown> {
  const value = step["with"] ?? {};
  assert.ok(record(value));
  return value;
}

function expandedJobIds(current: Workflow): readonly string[] {
  const result: string[] = [];
  for (const [id, job] of Object.entries(current.jobs)) {
    assert.ok(job);
    if (id === "shadow-classifier") {
      continue;
    }
    const matrix = job.strategy?.matrix;
    if (id === "node26-compatibility") {
      const lanes = matrix?.["include"];
      assert.ok(lanes);
      for (const lane of lanes) {
        assert.ok(record(lane) && typeof lane.lane === "string");
        result.push(`node-compatibility (${lane.lane})`);
      }
    } else if (id === "linux-tests") {
      const pairs = matrix?.["pair"];
      assert.ok(pairs);
      for (const pair of pairs) {
        assert.ok(
          record(pair) && typeof pair.first === "string" && typeof pair.second === "string",
        );
        result.push(`linux-tests-${pair.first}-${pair.second}`);
      }
    } else if (id === "windows-package" || id === "windows-registry") {
      const groups = matrix?.["group"];
      assert.ok(groups);
      for (const group of groups) {
        assert.ok(typeof group === "string");
        result.push(`${id} (${group})`);
      }
    } else if (id === "macos-package") {
      const profiles = matrix?.["profile"];
      assert.ok(profiles);
      for (const profile of profiles) {
        assert.ok(typeof profile === "string");
        result.push(`${id} (${profile})`);
      }
    } else {
      result.push(id);
    }
  }
  return result.toSorted();
}

void test("the ordinary CI topology preserves the typed 34-job native authority", async () => {
  const current = await workflow("ci.yml");
  assert.deepEqual(expandedJobIds(current), [...nativeMergeProfile.jobs].toSorted());
  assert.equal(expandedJobIds(current).length, 34);
});

void test("retained pnpm authority is explicitly provisioned beside isolated Bun graphs", async () => {
  const current = await workflow("ci.yml");
  const pnpmJobs = [
    "node26-compatibility",
    "linux-static",
    "linux-tests",
    "linux-coverage",
    "linux-package",
    "linux-registry",
    "linux-published",
    "windows-static",
    "windows-test-a",
    "windows-test-b",
    "windows-test-c",
    "windows-test-d",
    "windows-test-e",
    "windows-package",
    "windows-registry",
    "windows-published",
    "macos-native",
    "macos-package",
  ];
  for (const id of pnpmJobs) {
    const setup = current.jobs[id]?.steps.find(
      (step) => typeof step["uses"] === "string" && step["uses"].startsWith("pnpm/setup@"),
    );
    assert.equal(setup?.["uses"], pnpmSetup, id);
    assert.deepEqual(setup["with"], { version: "11.20.0", install: false }, id);
  }
  for (const id of [
    "linux-tests",
    "linux-coverage",
    "linux-static",
    "windows-static",
    "windows-test-a",
    "windows-test-b",
    "windows-test-c",
    "windows-test-d",
    "windows-test-e",
    "macos-native",
  ]) {
    const steps = current.jobs[id]?.steps ?? [];
    assert.equal(
      steps.some((step) => stepWith(step)["cache"] === "pnpm"),
      false,
      id,
    );
  }
  assert.equal(
    Object.values(current.jobs).some(
      (job) => job !== undefined && job.steps.some((step) => stepWith(step)["cache"] === "pnpm"),
    ),
    false,
  );
});

void test("pnpm setup scopes its Bun-manifest exception to the preparation step", async () => {
  const files = (await readdir(join(repositoryRoot, ".github/workflows"))).filter((name) =>
    name.endsWith(".yml"),
  );
  let setupCount = 0;
  for (const name of files) {
    const current = await workflow(name);
    assert.equal(current.env?.["pnpm_config_pm_on_fail"], undefined, name);
    for (const [id, job] of Object.entries(current.jobs)) {
      assert.ok(job);
      assert.equal(job.env?.["pnpm_config_pm_on_fail"], undefined, `${name}/${id}`);
      for (const step of job.steps) {
        const environment = step["env"];
        assert.ok(workflowEnvironment(environment));
        if (typeof step["uses"] === "string" && step["uses"].startsWith("pnpm/setup@")) {
          setupCount += 1;
          assert.equal(step["uses"], pnpmSetup, `${name}/${id}`);
          assert.deepEqual(stepWith(step), { version: "11.20.0", install: false }, `${name}/${id}`);
          assert.deepEqual(environment, { pnpm_config_pm_on_fail: "ignore" }, `${name}/${id}`);
        } else {
          assert.equal(environment?.["pnpm_config_pm_on_fail"], undefined, `${name}/${id}`);
        }
      }
    }
  }
  assert.ok(setupCount > 0);
});

void test("pinned pnpm setup version probe accepts Bun only with its scoped preparation environment", async () => {
  const runtime = await resolveQualificationExecutables("node");
  const pnpm = await resolvePnpmInvocation(runtime.node, "11.20.0");
  const root = await ownedTemporaryRoot("pnpm-setup-probe-");
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "TEST-pnpm-setup-probe",
        private: true,
        packageManager: "bun@1.4.3",
      }),
    );
    const environment = { ...process.env, pnpm_config_pm_on_fail: "error" };
    const probe = (env: NodeJS.ProcessEnv) =>
      spawnSync(pnpm.command, [...pnpm.args, "--version"], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10_000,
      });
    const rejected = probe(environment);
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}${rejected.stderr}`, /This project is configured to use bun/u);
    const ci = await workflow("ci.yml");
    const setup = ci.jobs["linux-static"]?.steps.find((step) => step["uses"] === pnpmSetup);
    const setupEnvironment = setup?.["env"];
    assert.ok(processEnvironment(setupEnvironment));
    const accepted = probe({ ...environment, ...setupEnvironment });
    assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
    assert.equal(accepted.stdout.trim(), "11.20.0");
    const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.ok(record(manifest));
    assert.equal(manifest.packageManager, "bun@1.4.3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("signed RC preparation retains clean source custody and its owned pnpm projection", async () => {
  const current = await workflow("ci-input-proof-rc.yml");
  const steps = current.jobs["prepare"]?.steps ?? [];
  const bun = steps.find(
    (step) => typeof step["uses"] === "string" && step["uses"].startsWith("oven-sh/setup-bun@"),
  );
  assert.deepEqual(stepWith(bun ?? {}), { "bun-version": "1.4.3" });
  assert.ok(steps.some((step) => step["run"] === "node tools/dev.mts install"));
  assert.equal(
    steps.some((step) => stepWith(step)["cache"] === "pnpm"),
    false,
  );
  assert.equal(
    steps.some((step) => typeof step["run"] === "string" && /^pnpm\s+install/u.test(step["run"])),
    false,
  );
  const prepare = steps.find((step) => step["id"] === "artifact");
  assert.equal(
    prepare?.["run"],
    'node scripts/prepare-ci-input-proof-rc.mts "${RUNNER_TEMP}/ci-input-proof-rc" "${EXPECTED_COMMIT}"',
  );
  assert.equal(prepare["working-directory"], undefined);
});

void test("native pnpm setup output is consumed through exact portable manager paths", async () => {
  const current = await workflow("ci.yml");
  const projectedJobs = [
    "node26-compatibility",
    "linux-package",
    "linux-registry",
    "linux-published",
    "linux-bootstrap-evidence",
    "windows-package",
    "windows-registry",
    "windows-published",
    "macos-package",
  ];
  const expectedEntry =
    "${{ steps.setup-pnpm.outputs.bin-dest }}/pnpm${{ runner.os == 'Windows' && '.exe' || '' }}";
  const source = await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  assert.doesNotMatch(source, /\$\{\{[^}\n]*runner\.os == "Windows"[^}\n]*\}\}/u);
  for (const id of projectedJobs) {
    const steps = current.jobs[id]?.steps ?? [];
    const setup = steps.find((step) => step["id"] === "setup-pnpm");
    assert.equal(setup?.["uses"], pnpmSetup, id);
    assert.deepEqual(setup["with"], { version: "11.20.0", install: false }, id);
    const install = steps.find(
      (step) =>
        typeof step["run"] === "string" &&
        step["run"].includes("tools/dev.mts --profile node install"),
    );
    const installEnvironment = install?.["env"];
    assert.ok(workflowEnvironment(installEnvironment));
    assert.equal(installEnvironment?.["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"], expectedEntry, id);
  }
  assert.equal(pnpmPortableName("linux"), "pnpm");
  assert.equal(pnpmPortableName("win32"), "pnpm.exe");
});

function portableManagerFixture(version: string): string {
  return (
    `#!${process.execPath}\n` +
    "const args = process.argv.slice(2);\n" +
    `if (args.includes("--version")) process.stdout.write("${version}" + String.fromCharCode(10));\n`
  );
}

void test("portable native manager fixtures reject wrong versions before operations", async () => {
  if (process.platform === "win32") {
    return;
  }
  const parent = await ownedTemporaryRoot("pnpm-native-");
  const bin = join(parent, "bin");
  const wrongBin = join(parent, "wrong-bin");
  const previousEntrypoint = process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"];
  try {
    await Promise.all([mkdir(bin), mkdir(wrongBin)]);
    const path = join(bin, pnpmPortableName());
    await writeFile(path, portableManagerFixture("11.20.0"), "utf8");
    await chmod(path, 0o755);
    process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"] = path;
    const invocation = await resolvePnpmInvocation(process.execPath, "11.20.0");
    assert.equal(invocation.kind, "native");
    assert.equal(invocation.command, await realpath(path));
    const wrong = join(wrongBin, "pnpm");
    await writeFile(wrong, portableManagerFixture("99.0.0"), "utf8");
    await chmod(wrong, 0o755);
    process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"] = wrong;
    await assert.rejects(resolvePnpmInvocation(process.execPath, "11.20.0"), /not pnpm 11\.20\.0/u);
  } finally {
    if (previousEntrypoint === undefined) {
      delete process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"];
    } else {
      process.env["AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT"] = previousEntrypoint;
    }
    await rm(parent, { recursive: true, force: true });
  }
});

void test("Node compatibility and package qualification execute in the private pnpm projection", async () => {
  const current = await workflow("ci.yml");
  const compatibility = current.jobs["node26-compatibility"];
  assert.ok(compatibility);
  assert.equal(compatibility.env?.["AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE"], "node");
  const qualification = compatibility.steps.find((step) =>
    runs(step, "pnpm node-compatibility:qualification"),
  );
  assert.equal(qualification?.["working-directory"], ".worker-tmp/profiles/node-${{ github.sha }}");
  const capture = compatibility.steps.find(
    (step) => typeof step["run"] === "string" && step["run"].includes("COMPAT_NODE_EXECUTABLE="),
  );
  assert.ok(capture);
  for (const id of [
    "linux-package",
    "linux-registry",
    "linux-published",
    "windows-package",
    "windows-registry",
    "windows-published",
    "macos-package",
  ]) {
    const job = current.jobs[id];
    assert.ok(job);
    assert.equal(job.env?.["AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE"], "node", id);
    assert.ok(
      job.steps.some((step) => runs(step, "node tools/dev.mts --profile node install")),
      id,
    );
    assert.ok(
      job.steps.some((step) => runs(step, "node tools/dev.mts --profile node build")),
      id,
    );
    assert.equal(
      job.steps.some(
        (step) =>
          runs(step, "node scripts/pack-test.mjs") && step["working-directory"] === undefined,
      ),
      false,
      id,
    );
    assert.ok(
      job.steps.every(
        (step) =>
          step["working-directory"] !== ".worker-tmp/profiles/node-${{ github.sha }}" ||
          typeof step["run"] !== "string" ||
          !step["run"].includes("bun "),
      ),
      id,
    );
  }
  const bootstrap = current.jobs["linux-bootstrap-evidence"];
  assert.ok(bootstrap);
  const bootstrapInstall = bootstrap.steps.find((step) =>
    runs(step, "node tools/dev.mts --profile node install"),
  );
  assert.equal(bootstrapInstall?.["working-directory"], undefined);
  const candidate = bootstrap.steps.find(
    (step) =>
      typeof step["run"] === "string" &&
      step["run"].includes("tool npm-package-bootstrap:candidate-evidence"),
  );
  assert.equal(candidate?.["working-directory"], ".worker-tmp/profiles/node-${{ github.sha }}");
  assert.deepEqual(candidate["env"], {
    AGENT_TEAMS_FOUNDATION_SOURCE_ROOT: "${{ github.workspace }}",
    AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT:
      "${{ steps.setup-pnpm.outputs.bin-dest }}/pnpm${{ runner.os == 'Windows' && '.exe' || '' }}",
  });
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function workflowEnvironment(value: unknown): value is Record<string, unknown> | undefined {
  return value === undefined || record(value);
}
function processEnvironment(value: unknown): value is Record<string, string> | undefined {
  return (
    value === undefined ||
    (record(value) && Object.values(value).every((entry) => typeof entry === "string"))
  );
}
function isWorkflow(value: unknown): value is Workflow {
  if (!record(value) || !workflowEnvironment(value.env) || !record(value.jobs)) {
    return false;
  }
  return Object.values(value.jobs).every((job) => {
    if (
      !record(job) ||
      !workflowEnvironment(job.env) ||
      !Array.isArray(job.steps) ||
      !job.steps.every(record)
    ) {
      return false;
    }
    if (job.strategy === undefined) {
      return true;
    }
    return (
      record(job.strategy) &&
      (job.strategy.matrix === undefined ||
        (record(job.strategy.matrix) && Object.values(job.strategy.matrix).every(Array.isArray)))
    );
  });
}
