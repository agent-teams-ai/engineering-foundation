import assert from "node:assert/strict";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertAuthority,
  authorityRevision,
  command,
  fileHash,
  git,
  github,
  invoke,
  json,
  list,
  producerRoot,
  record,
  roots,
  row,
  selected,
  selectAuthority,
  selectedEnvironment,
  sourceRevision,
  sourceTree,
  text,
  toolsRoot,
  trackedImages,
  type BootstrapResult,
  type HostedRuntime,
  type Row,
} from "./bootstrap-io.ts";
import { authenticateController } from "./bootstrap-controller.ts";
import {
  prepareAuthority,
  preparePackageManagers,
  prepareSourceFixture,
  prepareTargetFixture,
  prepareWrongManager,
} from "./bootstrap-prerequisites.ts";
export type { BootstrapResult } from "./bootstrap-io.ts";

function admitRetainedInputs(): Row[] {
  const manifestPath = join(toolsRoot, "original-source-inventory.json");
  const manifest = json(manifestPath);
  assert.equal(manifest["schemaVersion"], 1);
  assert.equal(manifest["producerBase"], "7438b7ee4429dc7798cf2b18c81e6bc7788f0f5b");
  const expectedPaths = [
    "fixtures/controller-package.json",
    "fixtures/controller-package-lock.json",
    "fixtures/controller-archive-integrity.json",
    "fixtures/installed-repository-mutation-inventory.json",
    "fixtures/installed-document-authoring-inventory.json",
    "fixtures/installed-docs-protocol-inventory.json",
    "fixtures/installed-docs-protocol-agent-teams-inventory.json",
    "fixtures/finite-execution.review-plan.json",
    "fixtures/host-checkpoint.patch",
  ].toSorted();
  const entries = list(manifest["originalInputs"], "Original retained input census")
    .map((value) => row(value, "Original retained input"))
    .filter((value) => text(value["path"], "Retained input path").startsWith("fixtures/"));
  assert.deepEqual(entries.map((value) => value["path"]).toSorted(), expectedPaths);
  const result = entries.map((entry) => {
    const path = join(toolsRoot, text(entry["path"], "Retained input path"));
    const stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    assert.equal(stat.size, entry["bytes"]);
    assert.equal(fileHash(path), entry["sha256"]);
    return { ...entry, actualPath: path };
  });
  record("retained-input-admission", {
    manifest: selected(manifestPath),
    inputs: result,
    scope:
      "Original byte-preserved fixture admission; new helper source remains independently reviewed current code.",
  });
  return result;
}

async function verifyProducerPreflight(harnessRevision: string): Promise<Row> {
  const runId = text(process.env["EF70_PREFLIGHT_RUN_ID"], "Actual producer preflight run ID");
  assert.match(runId, /^[1-9][0-9]*$/u);
  const run = await github(
    "engineering-foundation/actions/runs/" + runId,
    "producer-preflight-run",
  );
  assert.equal(String(run["id"]), runId);
  assert.equal(run["run_attempt"], 1, "Select the original completed preflight attempt");
  assert.equal(run["status"], "completed");
  assert.equal(run["conclusion"], "success");
  assert.equal(run["event"], "push");
  assert.equal(run["head_sha"], harnessRevision);
  assert.equal(run["head_branch"], "test/ef70-managed-campaign");
  assert.equal(run["path"], ".github/workflows/ef70-managed-campaign.yml");
  assert.equal(row(run["repository"], "Producer preflight repository")["id"], 1316243988);
  assert.equal(row(run["head_repository"], "Producer preflight head repository")["id"], 1316243988);
  const response = await github(
    "engineering-foundation/actions/runs/" + runId + "/attempts/1/jobs?per_page=100",
    "producer-preflight-jobs",
  );
  const jobs = list(response["jobs"], "Actual producer jobs").map((value) =>
    row(value, "Actual job"),
  );
  assert.equal(response["total_count"], jobs.length, "Complete finite job census required");
  assert(jobs.length > 0 && jobs.length <= 4);
  const matches = jobs.filter((job) => job["name"] === "ef70-harness-preflight");
  assert.equal(matches.length, 1);
  const job = matches[0]!;
  assert.equal(job["status"], "completed");
  assert.equal(job["conclusion"], "success");
  assert.equal(job["head_sha"], harnessRevision);
  const steps = list(job["steps"], "Preflight step census").map((value) =>
    row(value, "Preflight step"),
  );
  for (const name of [
    "Install the ordinary producer profile",
    "Build current producer source with its admitted compiler",
    "Run explicit Stack cleanup and require unchanged source",
    "Provision the unchanged frozen managed test tools",
    "Check the complete actual committed delta",
    "Run the unchanged required fast route",
    "Qualify workflow security",
  ]) {
    const selectedSteps = steps.filter((step) => step["name"] === name);
    assert.equal(selectedSteps.length, 1, "Missing exact producer preflight step: " + name);
    assert.equal(selectedSteps[0]!["status"], "completed");
    assert.equal(selectedSteps[0]!["conclusion"], "success");
  }
  const result = {
    runId,
    attempt: 1,
    head: harnessRevision,
    jobId: job["id"],
    workflow: run["path"],
    workflowId: run["workflow_id"],
    runUrl: run["html_url"],
    actualRequiredSteps: steps,
    scope:
      "Actual ordinary exact-source preflight execution. Not a reusable trusted admission or full-ci authority grant.",
  };
  record("producer-preflight-verified", result);
  return result;
}

function assertHostedRuntime(): void {
  assert.equal(process.versions.node, "26.12.1");
  assert.equal(
    realpathSync(process.execPath),
    realpathSync(text(process.env["EF70_NODE26_EXECUTABLE"], "Physical Node26 selection")),
  );
  assert(
    availableParallelism() >= 1 && availableParallelism() <= 2,
    "Use real two-CPU process affinity",
  );
  assert.equal(
    realpathSync(text(process.env["GITHUB_WORKSPACE"], "Actual source checkout")),
    producerRoot,
  );
}

function observeRuntime(): HostedRuntime {
  const harnessRevision = text(
    process.env["EF70_HARNESS_REVISION"],
    "Immutable producer harness revision",
  );
  const hostRevision = text(process.env["GITHUB_SHA"], "Actual EF caller revision");
  assert.match(harnessRevision, /^[0-9a-f]{40}$/u);
  assert.match(hostRevision, /^[0-9a-f]{40}$/u);
  const node26 = realpathSync(process.execPath);
  const node24 = realpathSync(
    text(process.env["EF70_NODE24_EXECUTABLE"], "Physical Node24 selection"),
  );
  const npmEntrypoint = join(dirname(dirname(node26)), "lib/node_modules/npm/bin/npm-cli.js");
  assert(lstatSync(npmEntrypoint).isFile());
  for (const name of ["corepack-cache", "pnpm-store", "npm-cache", "tmp"]) {
    mkdirSync(join(roots.root, name), { mode: 0o700 });
  }
  Object.assign(selectedEnvironment, {
    PATH: dirname(node26) + ":" + text(process.env["PATH"], "Runner PATH"),
    COREPACK_HOME: join(roots.root, "corepack-cache"),
    pnpm_config_store_dir: join(roots.root, "pnpm-store"),
    npm_config_cache: join(roots.root, "npm-cache"),
    TMPDIR: join(roots.root, "tmp"),
    PNPM_MAX_WORKERS: "1",
    NODE_OPTIONS: "--import=" + pathToFileURL(join(toolsRoot, "compiler-guard.ts")).href,
    EF70_COMPILER_GUARD_LOG: join(roots.evidenceRoot, "runtime-guard.jsonl"),
    EF70_CAMPAIGN_ROOT: roots.root,
    AGENT_TEAMS_DOCS_UPGRADE_NODE24_EXECUTABLE: node24,
    AGENT_TEAMS_DOCS_UPGRADE_NODE26_EXECUTABLE: node26,
  });
  const runtime: Row[] = [];
  for (const [label, executable, version] of [
    ["node24", node24, "24.22.3"],
    ["node26", node26, "26.12.1"],
  ] as const) {
    assert.equal(
      command(label + "-version", executable, ["-p", "process.versions.node"], roots.root)
        .toString("utf8")
        .trim(),
      version,
    );
    runtime.push({
      version,
      executable,
      sha256: fileHash(executable),
      mode: lstatSync(executable).mode & 0o777,
    });
  }
  assert.equal(git(producerRoot, "producer-head", ["rev-parse", "HEAD"]), harnessRevision);
  git(producerRoot, "producer-base-ancestry", [
    "merge-base",
    "--is-ancestor",
    "7438b7ee4429dc7798cf2b18c81e6bc7788f0f5b",
    harnessRevision,
  ]);
  const harnessTree = git(producerRoot, "producer-tree", ["rev-parse", "HEAD^{tree}"]);
  return { node24, node26, npmEntrypoint, harnessRevision, hostRevision, harnessTree, runtime };
}

async function qualifyHarness(host: HostedRuntime, producerPreflight: Row): Promise<void> {
  const { node26, harnessRevision, hostRevision, harnessTree, runtime } = host;
  const compilerOwner = row(
    await import(pathToFileURL(join(producerRoot, "tools/typescript-admission.ts")).href),
    "Producer metadata-only compiler admission",
  );
  const compiler = row(
    await invoke(compilerOwner, "admitRepositoryTypeScript", [producerRoot]),
    "Actual admitted native TypeScript",
  );
  assert.equal(compiler["version"], "7.0.2");
  command(
    "harness-strict-typecheck",
    node26,
    [
      text(compiler["entry"], "Admitted compiler entry"),
      "--project",
      join(producerRoot, "tsconfig.ef70-managed-campaign.json"),
      "--pretty",
      "false",
    ],
    producerRoot,
  );
  record("compiler-admission", compiler);
  const statfs = statfsSync(roots.root);
  record("host-context", {
    ...roots,
    prerequisiteGeneration: roots.prerequisiteGeneration,
    producerRevision: harnessRevision,
    producerTree: harnessTree,
    hostRepository: process.env["GITHUB_REPOSITORY"],
    hostRepositoryId: process.env["GITHUB_REPOSITORY_ID"],
    hostRevision,
    producerPreflight,
    workflowSha: process.env["GITHUB_WORKFLOW_SHA"],
    githubSha: process.env["GITHUB_SHA"],
    runtime,
    actualParallelism: availableParallelism(),
    cpuAffinity: readFileSync("/proc/self/status", "utf8")
      .split("\n")
      .find((line) => line.startsWith("Cpus_allowed_list:")),
    freeBytes: statfs.bavail * statfs.bsize,
    nodeModuleGuard: selected(join(toolsRoot, "compiler-guard.ts")),
    scope:
      "Preparation in one official hosted Linux job. No authority publication or managed operation yet.",
  });
}

async function bootstrap(): Promise<BootstrapResult> {
  assertHostedRuntime();
  const retainedInputs = admitRetainedInputs();
  const host = observeRuntime();
  const { node24, node26, npmEntrypoint, harnessRevision, hostRevision, harnessTree } = host;
  const producerPreflight = await verifyProducerPreflight(harnessRevision);
  await qualifyHarness(host, producerPreflight);
  const authority = await selectAuthority();
  const corepackEntrypoint = preparePackageManagers(host);
  const { sourceRoot, sourceImages } = prepareSourceFixture(host, corepackEntrypoint);
  const { centralRoot, candidatePath, qualified, sourceOwner } = await prepareAuthority(
    host,
    corepackEntrypoint,
    authority,
  );
  const targetLockPath = prepareTargetFixture(host, corepackEntrypoint, sourceRoot, centralRoot);
  const controllerInstallation = join(roots.root, "controller");
  const archives = await authenticateController(
    centralRoot,
    controllerInstallation,
    node26,
    npmEntrypoint,
    list(qualified["packages"], "Qualified coordinates").map((value) => row(value, "Coordinate")),
  );
  prepareWrongManager(host, corepackEntrypoint, sourceRoot);
  assert.deepEqual(trackedImages(sourceRoot, "source-final"), sourceImages);
  assert.equal(
    git(sourceRoot, "source-final-clean", ["status", "--porcelain=v1", "--untracked-files=no"]),
    "",
  );
  assert.equal(
    git(centralRoot, "central-final-clean", ["status", "--porcelain=v1", "--untracked-files=no"]),
    "",
  );
  await assertAuthority("authority-after");
  return {
    schemaVersion: 1,
    root: roots.root,
    evidenceRoot: roots.evidenceRoot,
    sourceRoot,
    centralRoot,
    controllerInstallation,
    node24Executable: node24,
    node26Executable: node26,
    corepackEntrypoint,
    candidate: selected(candidatePath),
    targetLock: selected(targetLockPath),
    environment: selectedEnvironment,
    sourceRevision,
    authorityRevision,
    authorityTree: authority.tree,
    sourceTree,
    sourceOwner,
    controllerArchivesVerification: archives,
    prerequisiteGeneration: roots.prerequisiteGeneration,
    retainedInputs,
    hostRepository: "agent-teams-ai/extension-foundation",
    hostRepositoryId: 1333298097,
    hostRevision,
    harnessRevision,
    harnessTree,
    producerPreflight,
  };
}

try {
  const result = await bootstrap();
  const path = join(roots.evidenceRoot, "bootstrap-result.json");
  writeFileSync(path, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const githubOutput = process.env["GITHUB_OUTPUT"];
  if (githubOutput) {
    appendFileSync(githubOutput, "bootstrap-result=" + path + "\n");
  }
  console.log(
    JSON.stringify({
      outcome: "prepared",
      bootstrapResult: selected(path),
      scope:
        "Actual authenticated preparation only; seven chains and fifteen refusals remain separate.",
    }),
  );
} catch (error) {
  record("failure", {
    observedAt: new Date().toISOString(),
    message: error instanceof Error ? error.message : String(error),
    actualManagedOperations: [],
    scope: "Bootstrap failed; existing effects are retained and are not a successful campaign.",
  });
  throw error;
}
