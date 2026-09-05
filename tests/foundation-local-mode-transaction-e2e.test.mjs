import assert from "node:assert/strict";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  actualSourceDependenciesCLI,
  copySourcePolicyFixture,
  observeFoundationFeatureGraph
} from "./helpers/local-mode-boundaries.mjs";
import { spawnSync } from "node:child_process";
import { installedFoundationVersion } from "../packages/engineering-foundation/dist/transaction-coordination/adapters/node/installed-foundation-version.js";

import { createNodeFoundationTransactionCoordinator } from "../packages/engineering-foundation/dist/composition/node-foundation-transaction-coordinator.js";
import { FoundationTransactionCoordinator } from "../packages/engineering-foundation/dist/transaction-coordination/application/foundation-transaction-coordinator.js";
import { FoundationTransactionError } from "../packages/engineering-foundation/dist/transaction-coordination/application/foundation-transaction-error.js";
import {
  applyFilesystemScaffold,
  planScaffoldFromFile,
  recoverFilesystemScaffold,
} from "../packages/engineering-foundation/dist/scaffolding/index.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const scaffoldFixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-authority-consumer",
);

function statePath(root) {
  return join(root, ".agent-teams-local", "foundation-link.json");
}

function backupPath(root) {
  return join(root, ".agent-teams-local", "foundation-registry-backup");
}

function transactionPath(root) {
  return join(root, ".agent-teams-local", "scaffolding-transaction.json");
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function observe(path) {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false };
    }
    if (error?.code === "EISDIR" || error?.code === "EPERM") {
      const metadata = await lstat(path);
      return {
        exists: true,
        type: metadata.isDirectory() ? "directory" : "other",
      };
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    return metadata.isFile()
      ? { exists: true, type: "file", bytes: await handle.readFile() }
      : { exists: true, type: metadata.isDirectory() ? "directory" : "other" };
  } finally {
    await handle.close();
  }
}

async function prepareCrashEvidence(root, phase) {
  const backup = backupPath(root);
  await mkdir(backup, { recursive: true });
  await writeFile(join(backup, "package.json"), '{"name":"registry-backup"}\n');
  if (phase === "orphan-backup") {
    return;
  }
  await writeJson(statePath(root), {
    schemaVersion: 1,
    phase,
    consumerRoot: root,
    targetPackageRoot: join(root, ".foundation-source"),
    registryBackupPath: backup,
    registryEntryKind: "directory",
    registryPackageRoot: join(
      root,
      "node_modules",
      "@agent-teams",
      "engineering-foundation",
    ),
    packageVersion: "0.12.0",
    gitCommit: "a".repeat(40),
    gitDirty: false,
    attachedAt: "2026-08-12T00:00:00.000Z",
  });
}

function coordinatorWith(status) {
  return new FoundationTransactionCoordinator({
    lock: { async acquire() { return async () => {}; } },
    slot: { async inspect() { return status; } },
  });
}

test("admits detach recovery only for local-mode evidence", async () => {
  const scaffolding = coordinatorWith({
    state: "pending",
    operationKind: "scaffolding",
    format: "legacy-scaffolding-v1",
    foundationVersion: "0.12.0",
    recovery: {
      commandId: "scaffold-recover",
      exactFoundationVersion: "0.12.0",
    },
    diagnostics: [
      { code: "FOUNDATION_TRANSACTION_ACTIVE", message: "pending scaffold" },
    ],
  });
  await assert.rejects(
    scaffolding.acquire({
      requestedMutation: "detach",
      allowRecoveryOf: "local-mode",
    }),
    (error) =>
      error instanceof FoundationTransactionError &&
      error.code === "FOUNDATION_TRANSACTION_ACTIVE",
  );
});

test("blocks every scaffold mutation over incomplete local-mode evidence", async (context) => {
  for (const phase of ["ATTACHING", "DETACHING", "orphan-backup"]) {
    await context.test(phase, async () => {
      const root = await mkdtemp(join(tmpdir(), "foundation-local-mode-crash-"));
      try {
        await cp(scaffoldFixtureRoot, root, { recursive: true });
        const plan = await planScaffoldFromFile({
          consumerRoot: root,
          intentPath: "intents/create-fixture.yaml",
        });
        await prepareCrashEvidence(root, phase);
        const evidencePaths = [
          statePath(root),
          backupPath(root),
          join(backupPath(root), "package.json"),
          transactionPath(root),
          `${transactionPath(root)}.tmp`,
          ...plan.operations.map(({ path }) => join(root, path)),
        ];
        const evidenceBefore = await Promise.all(evidencePaths.map(observe));
        const coordinator = await createNodeFoundationTransactionCoordinator(root);
        const status = await coordinator.inspect();
        assert.deepEqual(
          {
            state: status.state,
            operationKind: status.operationKind,
            format: status.format,
            recovery: status.recovery,
          },
          {
            state: "pending",
            operationKind: "local-mode",
            format: "local-mode-v1",
            recovery: { commandId: "detach" },
          },
        );

        const recovery = await coordinator.acquire({
          requestedMutation: "detach",
          allowRecoveryOf: "local-mode",
        });
        await recovery.release();
        for (const requestedMutation of ["attach", "document-authoring"]) {
          await assert.rejects(
            coordinator.acquire({ requestedMutation }),
            (error) =>
              error instanceof FoundationTransactionError &&
              error.status.operationKind === "local-mode",
          );
        }
        await assert.rejects(
          applyFilesystemScaffold(root, plan),
          (error) => error?.code === "SCAFFOLD_RECOVERY_REQUIRED",
        );
        await assert.rejects(
          recoverFilesystemScaffold(root),
          (error) => error?.code === "SCAFFOLD_RECOVERY_REQUIRED",
        );
        assert.deepEqual(
          await Promise.all(evidencePaths.map(observe)),
          evidenceBefore,
        );
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    });
  }
});

async function memoryLifecycle(options = {}) {
  const { LocalPackageLifecycle } = await import("../packages/engineering-foundation/dist/local-mode/application/service.js");
  const trace = [];
  let state;
  let backup = false;
  let local = false;
  let modeReads = 0;
  const faults = { ...options };
  const consumerRoot = "memory:consumer";
  const registryPackageRoot = "memory:registry";
  const targetPackageRoot = "memory:target";
  const pending = {
    state: "pending", operationKind: "local-mode", format: "local-mode-v1",
    recovery: { commandId: "detach" }, diagnostics: []
  };
  const coordinator = new FoundationTransactionCoordinator({
    lock: { async acquire() {
      trace.push("lock");
      return async ({ retainTransactionBarrier } = {}) => { trace.push(`release:${retainTransactionBarrier}`); };
    } },
    slot: { async inspect() {
      trace.push("slot");
      if (faults.failSlot && state?.phase === "DETACHING") { throw new Error("slot unreadable"); }
      return state?.phase === "LOCAL" || (!state && !backup) ? { state: "idle", diagnostics: [] } : pending;
    } }
  });
  const ports = {
    inspection: {
      async mode(_path, { ignoreOperationLock = false } = {}) {
        modeReads += 1;
        const mode = state?.phase === "LOCAL" && local ? "LOCAL" : !state && !local && !backup ? "REGISTRY" : "INVALID";
        trace.push(`mode:${mode}:${ignoreOperationLock}`);
        return {
          mode, consumerRoot,
          dependencySpec: faults.stale && modeReads === 2 ? "2.0.0" : "1.2.3",
          installedPackageRoot: local ? targetPackageRoot : registryPackageRoot,
          installedVersion: local ? "2.0.0" : "1.2.3",
          ...(state ? { linkState: structuredClone(state) } : {}), issues: []
        };
      },
      async devOnly() { return { consumerRoot, dependencySpec: "1.2.3", issues: [] }; }
    },
    target: {
      async verify() {
        trace.push("target");
        if (faults.cancelTarget) { throw faults.cancelTarget; }
        return { targetPackageRoot, packageVersion: "2.0.0" };
      },
      async git() { trace.push("git"); return { gitCommit: "a".repeat(40), gitDirty: false }; }
    },
    state: {
      async write(_root, next) { trace.push(`write:${next.phase}`); state = structuredClone(next); },
      async remove() { trace.push("remove"); state = undefined; }
    },
    links: {
      async prepare() { trace.push("prepare"); return { registryBackupPath: "memory:backup", registryEntryKind: "directory" }; },
      async ignoreLocalState() { trace.push("ignore"); },
      async replace() {
        trace.push("link");
        backup = true;
        if (faults.failLink) { throw new Error("link failed"); }
        local = true;
      },
      async restore() {
        trace.push("restore");
        if (faults.failRestore) { throw new Error("restore failed"); }
        backup = false;
        local = false;
      }
    },
    async coordinator() { trace.push("coordinator"); return coordinator; }
  };
  return {
    service: new LocalPackageLifecycle({ ports, now: () => new Date("2026-08-12T00:00:00.000Z") }),
    trace, faults, consumerRoot, targetPackageRoot,
    evidence: () => ({ state: structuredClone(state), backup, local })
  };
}

test("lifecycle sequences independently implemented ports around durable phases", async () => {
  const fixture = await memoryLifecycle();
  const attached = await fixture.service.attach(fixture.consumerRoot, fixture.targetPackageRoot);
  assert.equal(attached.status.mode, "LOCAL");
  assert.equal(attached.status.linkState.attachedAt, "2026-08-12T00:00:00.000Z");
  assert.deepEqual(fixture.trace, [
    "coordinator", "lock", "slot", "mode:REGISTRY:true", "mode:REGISTRY:true", "target", "git",
    "prepare", "ignore", "write:ATTACHING", "link", "write:LOCAL", "mode:LOCAL:true", "git", "slot", "release:false"
  ]);
  fixture.trace.length = 0;
  assert.equal((await fixture.service.detach(fixture.consumerRoot)).mode, "REGISTRY");
  assert.deepEqual(fixture.trace, [
    "mode:LOCAL:false", "coordinator", "lock", "slot", "mode:LOCAL:true", "write:DETACHING",
    "restore", "remove", "slot", "release:false", "mode:REGISTRY:false"
  ]);
});

test("alternate ports reject stale admission and cancellation before any link effect", async () => {
  const stale = await memoryLifecycle({ stale: true });
  await assert.rejects(stale.service.attach(stale.consumerRoot, stale.targetPackageRoot), { code: "LOCAL_STATE_INVALID" });
  assert.deepEqual(stale.trace, ["coordinator", "lock", "slot", "mode:REGISTRY:true", "mode:REGISTRY:true", "slot", "release:false"]);
  const cancelled = new Error("cancelled package observation");
  const fixture = await memoryLifecycle({ cancelTarget: cancelled });
  await assert.rejects(fixture.service.attach(fixture.consumerRoot, fixture.targetPackageRoot), (error) => error === cancelled);
  assert.equal(fixture.trace.includes("prepare"), false);
  assert.deepEqual(fixture.evidence(), { state: undefined, backup: false, local: false });
  assert.equal(fixture.trace.at(-1), "release:false");
});

test("attach rollback preserves aggregate failures and the orphan backup barrier", async () => {
  const fixture = await memoryLifecycle({ failLink: true, failRestore: true });
  await assert.rejects(fixture.service.attach(fixture.consumerRoot, fixture.targetPackageRoot), (error) => {
    assert.equal(error.code, "LOCAL_STATE_INVALID");
    assert.deepEqual(error.cause.errors.map(({ message }) => message), ["link failed", "restore failed"]);
    return true;
  });
  assert.deepEqual(fixture.trace.slice(-5), ["link", "restore", "remove", "slot", "release:true"]);
  assert.deepEqual(fixture.evidence(), { state: undefined, backup: true, local: false });
  const before = fixture.evidence();
  await assert.rejects(fixture.service.attach(fixture.consumerRoot, fixture.targetPackageRoot), { code: "FOUNDATION_TRANSACTION_ACTIVE" });
  assert.deepEqual(fixture.evidence(), before);
  fixture.faults.failRestore = false;
  assert.equal((await fixture.service.detach(fixture.consumerRoot)).mode, "REGISTRY");
});

test("failed detach preserves DETACHING and recovers only through a later detach", async () => {
  const fixture = await memoryLifecycle();
  await fixture.service.attach(fixture.consumerRoot, fixture.targetPackageRoot);
  fixture.faults.failRestore = true;
  fixture.trace.length = 0;
  await assert.rejects(fixture.service.detach(fixture.consumerRoot), /restore failed/u);
  const before = fixture.evidence();
  assert.equal(before.state.phase, "DETACHING");
  assert.equal(before.backup, true);
  assert.equal(fixture.trace.includes("remove"), false);
  assert.equal(fixture.trace.at(-1), "release:true");
  await assert.rejects(fixture.service.attach(fixture.consumerRoot, fixture.targetPackageRoot), { code: "FOUNDATION_TRANSACTION_ACTIVE" });
  assert.deepEqual(fixture.evidence(), before);
  fixture.faults.failRestore = false;
  assert.equal((await fixture.service.detach(fixture.consumerRoot)).mode, "REGISTRY");
});

test("an unavailable post-failure observation still retains the transaction barrier", async () => {
  const fixture = await memoryLifecycle();
  await fixture.service.attach(fixture.consumerRoot, fixture.targetPackageRoot);
  fixture.faults.failRestore = true;
  fixture.faults.failSlot = true;
  await assert.rejects(fixture.service.detach(fixture.consumerRoot), /slot unreadable/u);
  assert.equal(fixture.evidence().state.phase, "DETACHING");
  assert.equal(fixture.trace.at(-1), "release:true");
});


test("local lifecycle application has no concrete provider dependencies", async () => {
  const applicationRoot = join(repositoryRoot, "packages/engineering-foundation/src/local-mode/application");
  for (const name of ["service.ts", "attach-transaction.ts", "consumer-policy.ts", "mode-status.ts", "package-metadata.ts", "ports.ts"]) {
    const source = await readFile(join(applicationRoot, name), "utf8");
    assert.doesNotMatch(source, /from ["'](?:node:|yaml|[^"']*adapters\/|[^"']*composition\/)/u, name);
    assert.doesNotMatch(source, /\bprocess\.|new Date\(|Date\.now\(/u, name);
  }
});

test("local lifecycle and its providers have no runtime or type feature cycle", async () => {
  const graph = await observeFoundationFeatureGraph();
  assert.deepEqual(graph.missing, []);
  assert.deepEqual(graph.runtimeCycles, []);
  assert.deepEqual(graph.combinedCycles, []);
});

test("source policy admits the process port and denies concrete providers to local application", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-local-boundaries-"));
  try {
    await copySourcePolicyFixture(root);
    const service = join(root, "packages/engineering-foundation/src/local-mode/application/service.ts");
    const original = await readFile(service, "utf8");
    const cases = [
      ["", 0],
      ['export type { ProcessRunner as Port } from "../../process-execution/api.js";', 0],
      ['export { FOUNDATION_SCHEMA_IDS as ModuleAssemblyLeak } from "../../schema-ids.js";', 1],
      ['export { NodeProcessRunner as ConcreteAdapterLeak } from "../../process-execution/node-process-runner.js";', 1],
      ['export type { NodeProcessRunner as ConcreteAdapterLeak } from "../../process-execution/node-process-runner.js";', 1],
      ['export { NodeFoundationOperationLock as ConcreteAdapterLeak } from "../../transaction-coordination/adapters/node/node-foundation-operation-lock.js";', 1]
    ];
    for (const [addition, expectedExit] of cases) {
      await writeFile(service, `${original}\n${addition}\n`);
      const result = actualSourceDependenciesCLI(root);
      assert.equal(result.exitCode, expectedExit, JSON.stringify({ addition, result }));
      assert.equal(result.report.outcome, expectedExit === 0 ? "passed" : "violations");
      const diagnostics = result.report.capabilities.flatMap((capability) => capability.diagnostics);
      if (expectedExit === 0) {assert.deepEqual(diagnostics, []);}
      else {assert.ok(diagnostics.some((diagnostic) =>
        diagnostic.ruleId === "architecture.source-dependencies.forbidden-boundary-dependency" &&
        diagnostic.location.path.endsWith("local-mode/application/service.ts")
      ), JSON.stringify(diagnostics));}
    }
    await writeFile(service, original);
    for (const name of ["service", "inspection"]) {
      const compositionPath = join(root, `packages/engineering-foundation/src/local-mode/composition/${name}.ts`);
      const source = await readFile(compositionPath, "utf8");
      await writeFile(compositionPath, `${source}\nexport { createNodeFoundationTransactionCoordinator as ModuleAssemblyLeak } from "../../composition/node-foundation-transaction-coordinator.js";\n`);
      const result = actualSourceDependenciesCLI(root);
      assert.equal(result.exitCode, 1, JSON.stringify(result));
      assert.ok(result.report.capabilities.flatMap((capability) => capability.diagnostics).some((diagnostic) =>
        diagnostic.ruleId === "architecture.source-dependencies.forbidden-boundary-dependency" &&
        diagnostic.location.path.endsWith(`local-mode/composition/${name}.ts`)
      ), JSON.stringify(result.report));
      await writeFile(compositionPath, source);
    }
    for (const [path, addition] of [
      ["features/command-host/application/command-services.ts", 'export type { FoundationSchemaId as ModuleAssemblyLeak } from "../../../schema-ids.js";'],
      ["local-mode/application/model.ts", 'export { FOUNDATION_LINK_STATE_FILE as ModuleAssemblyLeak } from "../../foundation-state-contract.js";'],
      ["transaction-coordination/adapters/node/node-foundation-transaction-slot.ts", 'export { FOUNDATION_LINK_STATE_FILE as ModuleAssemblyLeak } from "../../../foundation-state-contract.js";']
    ]) {
      const target = join(root, "packages/engineering-foundation/src", path);
      const source = await readFile(target, "utf8");
      await writeFile(target, `${source}\n${addition}\n`);
      const result = actualSourceDependenciesCLI(root);
      assert.equal(result.exitCode, 1, JSON.stringify(result));
      assert.ok(result.report.capabilities.flatMap((capability) => capability.diagnostics).some((diagnostic) =>
        diagnostic.ruleId === "architecture.source-dependencies.forbidden-boundary-dependency" && diagnostic.location.path.endsWith(path)
      ), JSON.stringify(result.report));
      await writeFile(target, source);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("installed package version follows its relocated module URL independently of cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-installed-version-"));
  try {
    const packageRoot = join(root, "node_modules", "@agent-teams", "engineering-foundation");
    const modulePath = join(packageRoot, "dist/transaction-coordination/adapters/node/installed-foundation-version.js");
    await mkdir(dirname(modulePath), { recursive: true });
    await cp(join(repositoryRoot, "packages/engineering-foundation/dist/transaction-coordination/adapters/node/installed-foundation-version.js"), modulePath);
    await writeJson(join(packageRoot, "package.json"), { type: "module", version: "6.7.8-installed.2" });
    await writeJson(join(root, "package.json"), { version: "1.0.0-unrelated" });
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import { installedFoundationVersion } from ${JSON.stringify(pathToFileURL(modulePath).href)}; process.stdout.write(await installedFoundationVersion());`], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "6.7.8-installed.2");
    const manifest = JSON.parse(await readFile(join(repositoryRoot, "packages/engineering-foundation/package.json"), "utf8"));
    assert.equal(await installedFoundationVersion(), manifest.version);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed lifecycle, reporting and coordination retain identities and relative artifact paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-installed-identities-"));
  try {
    const source = join(repositoryRoot, "packages/engineering-foundation");
    const installed = join(root, "node_modules/@agent-teams/engineering-foundation");
    await mkdir(installed, { recursive: true });
    for (const path of ["dist", "schemas", "presets", "assets", "package.json"]) {
      await cp(join(source, path), join(installed, path), { recursive: true });
    }
    await symlink(join(source, "node_modules"), join(installed, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    await writeJson(join(installed, "package.json"), { ...manifest, version: "6.7.8-installed.2" });
    await writeJson(join(root, "package.json"), { type: "module", version: "99.88.77-cwd" });
    const script = `
      import assert from "node:assert/strict";
      import { readFile } from "node:fs/promises";
      import { FoundationError, localMode } from "@agent-teams/engineering-foundation";
      import { FoundationLocalModeService, NodeProcessRunner } from "@agent-teams/engineering-foundation/local-mode";
      import { FoundationError as ReportError } from "./node_modules/@agent-teams/engineering-foundation/dist/features/validation-reporting/foundation-error.js";
      import { ProcessCancellationError, ProcessTimeoutError } from "./node_modules/@agent-teams/engineering-foundation/dist/process-execution/api.js";
      import { installedFoundationVersion } from "./node_modules/@agent-teams/engineering-foundation/dist/transaction-coordination/adapters/node/installed-foundation-version.js";
      import { installedFoundationVersion as scaffoldVersion } from "./node_modules/@agent-teams/engineering-foundation/dist/scaffolding/adapters/node/installed-foundation-version.js";
      import { computeFoundationBuildIdentity, installedFoundationBuildIdentity } from "./node_modules/@agent-teams/engineering-foundation/dist/transaction-coordination/adapters/node/installed-foundation-build-identity.js";
      assert.equal(FoundationError, ReportError);
      assert.equal(localMode.FoundationLocalModeService, FoundationLocalModeService);
      assert.equal(localMode.NodeProcessRunner, NodeProcessRunner);
      assert(new ProcessCancellationError("cancelled") instanceof FoundationError);
      assert(new ProcessTimeoutError(1) instanceof FoundationError);
      const cause = new Error("cause");
      const failure = new FoundationError("CONFIG_INVALID", "message", { cause });
      assert.equal(failure.cause, cause);
      assert.equal(failure.name, "FoundationError");
      assert.equal(failure.code, "CONFIG_INVALID");
      assert.equal(await installedFoundationVersion(), "6.7.8-installed.2");
      assert.equal(await scaffoldVersion(), "6.7.8-installed.2");
      assert.equal(await installedFoundationBuildIdentity(), await computeFoundationBuildIdentity(${JSON.stringify(installed)}));
      const adapter = new URL("./node_modules/@agent-teams/engineering-foundation/dist/process-execution/windows-managed-process.js", import.meta.url);
      const source = await readFile(adapter, "utf8");
      const paths = [...source.matchAll(/new URL\\("([^"]+)", import.meta.url\\)/gu)].map((match) => match[1]);
      assert.deepEqual(paths, ["../../assets/windows-managed-process/bootstrap.ps1", "./windows-process-host.js"]);
      for (const path of paths) assert((await readFile(new URL(path, adapter))).length > 0);
      console.log("installed identities and artifact paths passed");
    `;
    await writeFile(join(root, "inspect.mjs"), script);
    const result = spawnSync(process.execPath, ["inspect.mjs"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const cli = spawnSync(process.execPath, [join(installed, "dist/cli.js"), "self-check", "--json"], { cwd: root, encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).packageVersion, "6.7.8-installed.2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
