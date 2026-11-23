import { isFile, profilesTemporaryParent } from "./support/repository-runtime-identity-cases.ts";
import { TOOL_COMMANDS } from "../tools/repository-tool-catalog.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectInstalledDependencies } from "../tools/dependencies-installed-check.mts";
import { checkEngineeringQualityStandard } from "../scripts/check-engineering-quality-standard.mts";
import { resolveQualificationExecutables } from "../tools/executable-policy.mts";
import { copySourceTree } from "../tools/dev.mts";
import { resolveNodeToolInvocation } from "../tools/repository-command.mts";

import { resolvePnpmInvocation } from "../tools/pnpm-command.mts";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

void test("pnpm launcher verifies the actual manager and ignores ambient npm_execpath", async (context) => {
  const manager = await resolvePnpmInvocation(process.execPath, "11.20.0");
  const pnpm = manager.kind === "javascript" ? manager.args[0] : manager.command;
  assert.ok(pnpm);
  const bun = (await resolveQualificationExecutables("bun")).bun;
  assert.ok(bun);
  if (!(await isFile(pnpm)) || !(await isFile(bun))) {
    context.skip("owned pnpm and Bun TEST toolchains are unavailable");
    return;
  }
  const root = await mkdtemp(join(profilesTemporaryParent(), "pnpm-manager-"));
  const project = join(root, "project");
  const bin = join(root, "bin");
  const tmp = join(root, "tmp");
  const wrong = join(root, "wrong-manager.cjs");
  const managerDirectory = join(bin, "manager");
  try {
    await mkdir(project);
    await mkdir(bin);
    await mkdir(tmp);
    await writeFile(
      join(project, "package.json"),
      `${JSON.stringify(
        {
          packageManager: "pnpm@11.20.0",
          scripts: { "verify-manager": "node manager.cjs" },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(project, "manager.cjs"),
      'require("node:fs").writeFileSync("manager-ran.txt", "pnpm");\n',
    );
    await writeFile(
      join(project, ".npmrc"),
      "ignore-workspace=true\npm-on-fail=ignore\nverify-deps-before-run=false\n",
      "utf8",
    );
    await writeFile(
      wrong,
      [
        'const fs = require("node:fs");',
        'if (process.argv.includes("run")) fs.writeFileSync("wrong-real-operation.txt", "wrong");',
        'console.log("99.0.0");',
      ].join("\n"),
    );
    // Keep the admitted manager's package-relative imports intact. Directory
    // junctions also work for the native Windows entrypoint without admin rights.
    await symlink(dirname(pnpm), managerDirectory, "junction");

    for (const launcher of [process.execPath, bun]) {
      const environment = {
        ...process.env,
        AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: process.execPath,
        AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT: wrong,
        npm_execpath: wrong,
        pnpm_config_ignore_workspace: "true",
        pnpm_config_pm_on_fail: "ignore",
        pnpm_config_verify_deps_before_run: "false",
        TMPDIR: tmp,
        PATH: `${managerDirectory}${delimiter}${process.env["PATH"] ?? ""}`,
      };
      const rejected = spawnSync(
        launcher,
        [resolve(repositoryRoot, "tools/pnpm-command.mts"), "run", "verify-manager"],
        { cwd: project, encoding: "utf8", env: environment, timeout: 10_000 },
      );
      assert.notEqual(rejected.status, 0);
      assert.match(`${rejected.stdout}${rejected.stderr}`, /not pnpm 11\.20\.0/u);
      assert.equal(await isFile(join(project, "wrong-real-operation.txt")), false);

      const accepted = spawnSync(
        launcher,
        [resolve(repositoryRoot, "tools/pnpm-command.mts"), "run", "verify-manager"],
        {
          cwd: project,
          encoding: "utf8",
          env: { ...environment, AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT: undefined },
          timeout: 10_000,
        },
      );
      assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
      assert.equal(await readFile(join(project, "manager-ran.txt"), "utf8"), "pnpm");
      assert.equal(await isFile(join(project, "wrong-real-operation.txt")), false);
      await rm(join(project, "manager-ran.txt"), { force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("extensionless fixed JS tools use the explicitly admitted Node executable", async () => {
  const root = await mkdtemp(join(profilesTemporaryParent(), "poisoned-path-"));
  const poisonBin = join(root, "bin");
  const poisonMarker = join(root, "poison-node-ran");
  const fixture = join(root, "fixture");
  try {
    const bun = (await resolveQualificationExecutables("bun")).bun;
    assert.ok(bun);
    assert.equal(await isFile(bun), true, "the owned admitted Bun fixture must be available");
    await mkdir(poisonBin);
    await mkdir(fixture);
    await writeFile(
      join(poisonBin, process.platform === "win32" ? "node.exe" : "node"),
      [
        `#!${process.execPath}`,
        `import { writeFileSync } from "node:fs";`,
        `writeFileSync(${JSON.stringify(poisonMarker)}, "poisoned");`,
        "process.exit(97);",
      ].join("\n"),
      { mode: 0o755 },
    );
    await writeFile(
      join(fixture, "tsconfig.ci-tooling.json"),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: "ES2024",
            module: "NodeNext",
            moduleResolution: "NodeNext",
          },
          files: ["index.ts"],
        },
        null,
        2,
      ),
    );
    await writeFile(join(fixture, "index.ts"), "export const value: number = 1;\n");
    const tscEntry = resolve(repositoryRoot, "node_modules/typescript/bin/tsc");
    const typecheckArgs = ["--project", "tsconfig.ci-tooling.json"];
    const environment = {
      ...process.env,
      AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: process.execPath,
      AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: bun,
      AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "bun",
      PATH: poisonBin,
    };

    // The historical suffix/direct-spawn behavior is exercised semantically:
    // the extensionless package entry must fail when PATH's Node is poisoned.
    if (process.platform !== "win32") {
      const oldDirect = spawnSync(tscEntry, typecheckArgs, {
        cwd: fixture,
        encoding: "utf8",
        env: environment,
        timeout: 10_000,
      });
      assert.equal(oldDirect.status, 97, `${oldDirect.stdout}${oldDirect.stderr}`);
      assert.equal(await isFile(poisonMarker), true);
      await rm(poisonMarker, { force: true });
    }

    const result = spawnSync(
      bun,
      [resolve(repositoryRoot, "tools/repository-command.mts"), "tool", "typecheck:ci-tooling"],
      {
        cwd: fixture,
        encoding: "utf8",
        env: environment,
        timeout: 30_000,
      },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(await isFile(poisonMarker), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("esbuild qualification uses its supported package entry in an isolated owner layout", async (context) => {
  const fixture = await mkdtemp(join(profilesTemporaryParent(), "esbuild-owner-"));
  const supportedEntry = join(fixture, "node_modules/esbuild/bin/esbuild");
  try {
    const testRequire = createRequire(import.meta.url);
    let esbuildManifestPath: string;
    try {
      esbuildManifestPath = testRequire.resolve("esbuild/package.json");
    } catch {
      context.skip("the owned esbuild graph is not materialized in this thin job");
      return;
    }
    const esbuildRoot = dirname(esbuildManifestPath);
    const esbuildRequire = createRequire(esbuildManifestPath);
    const esbuildManifest = JSON.parse(await readFile(esbuildManifestPath, "utf8")) as {
      readonly optionalDependencies?: Record<string, string>;
    };
    const optionalDependencies = Object.keys(esbuildManifest.optionalDependencies ?? {});
    const ownerNodeModules = join(fixture, "node_modules/esbuild/node_modules");
    const installedOwners: string[] = [];

    await cp(esbuildRoot, join(fixture, "node_modules/esbuild"), {
      recursive: true,
      dereference: true,
      force: true,
    });
    for (const packageName of optionalDependencies) {
      let ownerManifestPath: string;
      try {
        ownerManifestPath = esbuildRequire.resolve(`${packageName}/package.json`);
      } catch {
        continue;
      }
      const ownerRoot = dirname(ownerManifestPath);
      const destination = join(ownerNodeModules, packageName);
      await mkdir(dirname(destination), { recursive: true });
      await cp(ownerRoot, destination, { recursive: true, dereference: true, force: true });
      installedOwners.push(packageName);
    }

    assert.ok(
      installedOwners.length > 0,
      "the installed esbuild graph must contain an optional native owner",
    );
    assert.equal(await isFile(supportedEntry), true);
    assert.equal(await isPresent(join(fixture, "node_modules/@esbuild")), false);
    const invocation = resolveNodeToolInvocation(
      supportedEntry,
      ["--version"],
      [],
      process.execPath,
    );
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: fixture,
      encoding: "utf8",
      env: { ...process.env, AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: process.execPath },
      timeout: 10_000,
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /0\.28\.2/u);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function isPresent(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function writeManifest(path: string, manifest: unknown): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function assertInstalledGuardRejects(root: string, expected: RegExp): Promise<void> {
  try {
    const inventory = await inspectInstalledDependencies(root);
    assert.fail(`Installed guard falsely passed: ${JSON.stringify(inventory)}`);
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.match(error.message, expected);
  }
}

for (const optional of [false, true]) {
  void test(`installed guard rejects ancestor borrowing for ${optional ? "optional" : "required"} peers`, async () => {
    await mkdir(profilesTemporaryParent(), { recursive: true });
    const fixture = await mkdtemp(
      join(
        profilesTemporaryParent(),
        `TEST-installed-ancestor-${optional ? "optional" : "required"}-`,
      ),
    );
    const sourceRoot = join(fixture, "source");
    const profile = join(sourceRoot, ".worker-tmp/profiles/node-profile");
    const provider = join(sourceRoot, "node_modules/ambient-peer");
    const consumer = join(profile, "node_modules/consumer");
    try {
      await writeManifest(provider, {
        name: "ambient-peer",
        version: "1.0.0",
        main: "index.js",
        engines: { node: ">=1.0.0" },
      });
      await writeFile(join(provider, "index.js"), "module.exports = 'ambient';\n", "utf8");
      await writeManifest(consumer, {
        name: "consumer",
        version: "1.0.0",
        main: "index.js",
        peerDependencies: { "ambient-peer": "^1.0.0" },
        ...(optional ? { peerDependenciesMeta: { "ambient-peer": { optional: true } } } : {}),
      });
      await writeFile(join(consumer, "index.js"), "module.exports = 'consumer';\n", "utf8");
      await writeManifest(profile, {
        name: "nested-profile",
        version: "1.0.0",
        dependencies: { consumer: "1.0.0" },
      });
      await writeFile(
        join(profile, "pnpm-workspace.yaml"),
        'packages:\n  - "packages/*"\n',
        "utf8",
      );

      const runtimeResolution = createRequire(join(consumer, "index.js")).resolve("ambient-peer");
      assert.equal(await realpath(runtimeResolution), join(await realpath(provider), "index.js"));
      await assertInstalledGuardRejects(
        profile,
        /outside canonical graph root|resolves outside canonical graph root/u,
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}

void test("installed guard rejects ancestor optional peer without root entry", async () => {
  await mkdir(profilesTemporaryParent(), { recursive: true });
  const fixture = await mkdtemp(
    join(profilesTemporaryParent(), "TEST-installed-ancestor-export-only-"),
  );
  const sourceRoot = join(fixture, "source");
  const profile = join(sourceRoot, ".worker-tmp/profiles/node-profile");
  const provider = join(sourceRoot, "node_modules/ambient-peer");
  const consumer = join(profile, "node_modules/consumer");
  try {
    await writeManifest(provider, {
      name: "ambient-peer",
      version: "1.0.0",
      exports: { "./feature": "./feature.js" },
      engines: { node: ">=1.0.0" },
    });
    await writeFile(join(provider, "feature.js"), 'module.exports = "ambient";\n', "utf8");
    await writeManifest(consumer, {
      name: "consumer",
      version: "1.0.0",
      main: "index.js",
      peerDependencies: { "ambient-peer": "^1.0.0" },
      peerDependenciesMeta: { "ambient-peer": { optional: true } },
    });
    await writeFile(join(consumer, "index.js"), 'module.exports = "consumer";\n', "utf8");
    await writeManifest(profile, {
      name: "nested-profile",
      version: "1.0.0",
      dependencies: { consumer: "1.0.0" },
    });
    await writeFile(join(profile, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n', "utf8");

    const featureResolution = createRequire(join(consumer, "index.js")).resolve(
      "ambient-peer/feature",
    );
    assert.equal(await realpath(featureResolution), join(await realpath(provider), "feature.js"));
    let rootEntryError: unknown;
    try {
      createRequire(join(consumer, "index.js")).resolve("ambient-peer");
      assert.fail("The export-only package unexpectedly exposed a root entry");
    } catch (error) {
      rootEntryError = error;
    }
    assert.ok(rootEntryError instanceof Error);
    assert.equal((rootEntryError as NodeJS.ErrnoException).code, "ERR_PACKAGE_PATH_NOT_EXPORTED");
    await assertInstalledGuardRejects(profile, /outside canonical graph root/u);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

void test("installed guard rejects an in-root link to a foreign physical package", async () => {
  await mkdir(profilesTemporaryParent(), { recursive: true });
  const fixture = await mkdtemp(join(profilesTemporaryParent(), "TEST-installed-foreign-link-"));
  const root = join(fixture, "profile");
  const foreign = join(fixture, "foreign/linked-peer");
  try {
    await writeManifest(foreign, {
      name: "linked-peer",
      version: "1.0.0",
      main: "index.js",
    });
    await writeFile(join(foreign, "index.js"), "module.exports = 'foreign';\n", "utf8");
    await writeManifest(root, {
      name: "foreign-link-root",
      version: "1.0.0",
      dependencies: { "linked-peer": "1.0.0" },
    });
    await writeFile(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n', "utf8");
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(foreign, join(root, "node_modules/linked-peer"), "junction");

    const runtimeResolution = createRequire(join(root, "index.js")).resolve("linked-peer");
    assert.equal(await realpath(runtimeResolution), join(await realpath(foreign), "index.js"));
    await assertInstalledGuardRejects(root, /outside canonical graph root/u);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

void test("installed guard accepts deterministic in-root workspace peer links", async () => {
  await mkdir(profilesTemporaryParent(), { recursive: true });
  const root = await mkdtemp(join(profilesTemporaryParent(), "TEST-installed-workspace-link-"));
  try {
    const workspacePeer = join(root, "packages/workspace-peer");
    await writeManifest(root, {
      name: "workspace-link-root",
      version: "1.0.0",
      dependencies: { host: "1.0.0", "workspace-peer": "1.0.0" },
    });
    await writeFile(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n', "utf8");
    await writeManifest(join(root, "node_modules/host"), {
      name: "host",
      version: "1.0.0",
      peerDependencies: { "workspace-peer": "workspace:^" },
    });
    await writeManifest(workspacePeer, {
      name: "workspace-peer",
      version: "1.0.0",
      main: "index.js",
    });
    await writeFile(join(workspacePeer, "index.js"), "module.exports = 'workspace';\n", "utf8");
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(workspacePeer, join(root, "node_modules/workspace-peer"), "junction");

    const runtimeResolution = createRequire(join(root, "node_modules/host", "index.js")).resolve(
      "workspace-peer",
    );
    assert.equal(
      await realpath(runtimeResolution),
      join(await realpath(workspacePeer), "index.js"),
    );
    const first = await inspectInstalledDependencies(root);
    const second = await inspectInstalledDependencies(root);
    assert.deepEqual(second, first);
    assert.deepEqual(first, {
      outcome: "passed",
      packageContexts: [
        "workspace-link-root@1.0.0 -> host@host@1.0.0 [workspace-peer@>=1.0.0 <2.0.0-0=workspace-peer@1.0.0]",
        "workspace-link-root@1.0.0 -> workspace-peer@workspace-peer@1.0.0 []",
      ],
      packages: ["host@1.0.0", "workspace-peer@1.0.0"],
      peerAssignments: ["host@1.0.0 -> workspace-peer@>=1.0.0 <2.0.0-0=workspace-peer@1.0.0"],
    });
    await writeManifest(join(root, "node_modules/host"), {
      name: "host",
      version: "1.0.0",
      peerDependencies: { "workspace-peer": "workspace:^2.0.0" },
    });
    await assert.rejects(inspectInstalledDependencies(root), /Incompatible installed peer/u);
    await writeManifest(join(root, "node_modules/host"), {
      name: "host",
      version: "1.0.0",
      peerDependencies: { "workspace-peer": "workspace:^" },
    });
    // An npm-shaped shadow with identical name/version cannot impersonate the workspace.
    await writeManifest(join(root, "node_modules/host/node_modules/workspace-peer"), {
      name: "workspace-peer",
      version: "1.0.0",
    });
    await assert.rejects(
      inspectInstalledDependencies(root),
      /outside its declared workspace package/u,
    );
    await rm(join(root, "node_modules/host/node_modules/workspace-peer"), { recursive: true });
    await rm(join(root, "node_modules/workspace-peer"));
    await assert.rejects(
      inspectInstalledDependencies(root),
      /Required peer dependency is unresolved/u,
    );
    await symlink(workspacePeer, join(root, "node_modules/workspace-peer"), "junction");
    await writeManifest(workspacePeer, { name: "wrong-workspace-identity", version: "1.0.0" });
    await assert.rejects(inspectInstalledDependencies(root), /no declared workspace package/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("installed guard validates optional peer ranges and follows peer-only engine context", async () => {
  await mkdir(profilesTemporaryParent(), { recursive: true });
  const root = await mkdtemp(join(profilesTemporaryParent(), "installed-guard-"));
  try {
    await writeFile(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n', "utf8");
    await writeManifest(root, {
      name: "fixture-root",
      version: "1.0.0",
      dependencies: { host: "1.0.0", "optional-host": "1.0.0" },
    });
    await writeManifest(join(root, "node_modules/host"), {
      name: "host",
      version: "1.0.0",
      peerDependencies: { peer: "^2.0.0" },
    });
    await writeManifest(join(root, "node_modules/host/node_modules/peer"), {
      name: "peer",
      version: "2.0.0",
      engines: { node: ">=99.0.0" },
    });
    await writeManifest(join(root, "node_modules/optional-host"), {
      name: "optional-host",
      version: "1.0.0",
      peerDependencies: { absent: "not-a-range" },
      peerDependenciesMeta: { absent: { optional: true } },
    });
    await assert.rejects(inspectInstalledDependencies(root), /Malformed SemVer range.*absent/u);
    await writeManifest(join(root, "node_modules/optional-host"), {
      name: "optional-host",
      version: "1.0.0",
      peerDependencies: { absent: "^1.0.0" },
      peerDependenciesMeta: { absent: { optional: true } },
    });
    await assert.rejects(
      inspectInstalledDependencies(root),
      /Installed engine mismatch.*peer@2\.0\.0/u,
    );
    await writeManifest(join(root, "node_modules/host/node_modules/peer"), {
      name: "peer",
      version: "2.0.0",
      engines: { node: ">=1.0.0" },
    });
    const first = await inspectInstalledDependencies(root);
    const second = await inspectInstalledDependencies(root);
    assert.deepEqual(second, first);
    assert.ok(
      first.peerAssignments.includes(
        "optional-host@1.0.0 -> absent@>=1.0.0 <2.0.0-0=missing-optional",
      ),
    );
    await writeManifest(join(root, "node_modules/optional-host/node_modules/absent"), {
      name: "absent",
      version: "2.0.0",
    });
    await assert.rejects(
      inspectInstalledDependencies(root),
      /Incompatible installed peer.*absent@2\.0\.0/u,
    );
    await writeManifest(join(root, "node_modules/optional-host/node_modules/absent"), {
      name: "wrong-peer",
      version: "1.0.0",
    });
    await assert.rejects(inspectInstalledDependencies(root), /Installed peer identity mismatch/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("standards pin gate accepts reconciled evidence and rejects stale pins, classification and seam paths", async () => {
  const root = await mkdtemp(join(profilesTemporaryParent(), "standards-pin-"));
  try {
    await copySourceTree(repositoryRoot, root);
    await checkEngineeringQualityStandard(root);

    const provenancePath = join(root, "standards/engineering-quality-standard.provenance.json");
    const originalProvenance = await readFile(provenancePath, "utf8");
    const provenance = JSON.parse(originalProvenance) as { commit: string };
    provenance.commit = "stale-pin";
    await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
    await assert.rejects(checkEngineeringQualityStandard(root), /provenance does not match/u);
    await writeFile(provenancePath, originalProvenance, "utf8");

    const seamPath = join(root, "docs/architecture/runtime-profile-static-seam.md");
    const originalSeam = await readFile(seamPath, "utf8");
    await writeFile(seamPath, originalSeam.replace("Status: `not-adopted`", "Status: `adopted`"));
    await assert.rejects(
      checkEngineeringQualityStandard(root),
      /reviewed current and historical guidance/u,
    );
    await writeFile(seamPath, originalSeam, "utf8");

    await rm(
      join(root, "packages/engineering-foundation/src/process-execution/node-runtime-verifier.ts"),
    );
    await assert.rejects(
      checkEngineeringQualityStandard(root),
      /ENOENT|Runtime profile seam path is missing or unclassified/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A Bun repository root must not change the legacy managed test transport's
// package manager. Its exact pnpm comes from the same validated runtime policy
// as the explicit Node profile, never from root packageManager or a fallback.
void test("managed public test tooling selects pinned pnpm with a Bun root", async (t) => {
  const { readManagedTestPnpmVersion } =
    await import("../scripts/provision-managed-test-tools.mjs");
  await mkdir(profilesTemporaryParent(), { recursive: true });
  const root = await mkdtemp(join(profilesTemporaryParent(), "TEST-managed-tool-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "architecture/foundation"), { recursive: true });
  const manifest = { private: true, packageManager: "bun@1.4.3" };
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  await copyFile(
    join(repositoryRoot, "architecture/foundation/repository-runtime.json"),
    join(root, "architecture/foundation/repository-runtime.json"),
  );
  assert.equal(await readManagedTestPnpmVersion(root), "11.20.0");
  assert.deepEqual(JSON.parse(await readFile(join(root, "package.json"), "utf8")), manifest);
});

void test("managed public test tooling rejects wrong or missing runtime policy versions", async (t) => {
  const { readManagedTestPnpmVersion } =
    await import("../scripts/provision-managed-test-tools.mjs");
  await mkdir(profilesTemporaryParent(), { recursive: true });
  const root = await mkdtemp(join(profilesTemporaryParent(), "TEST-managed-tool-policy-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "architecture/foundation"), { recursive: true });
  const policyPath = join(root, "architecture/foundation/repository-runtime.json");
  const policy = JSON.parse(
    await readFile(join(repositoryRoot, "architecture/foundation/repository-runtime.json"), "utf8"),
  ) as {
    schemaVersion: number;
    toolchain: { pnpm: { version?: string } };
  };
  for (const version of ["11.19.0", undefined]) {
    const invalid = structuredClone(policy);
    if (version === undefined) {
      delete invalid.toolchain.pnpm.version;
    } else {
      invalid.toolchain.pnpm.version = version;
    }
    await writeFile(policyPath, JSON.stringify(invalid));
    await assert.rejects(readManagedTestPnpmVersion(root), /runtime policy identity is invalid/u);
  }
  await writeFile(policyPath, JSON.stringify({ ...policy, schemaVersion: 2 }));
  await assert.rejects(readManagedTestPnpmVersion(root), /runtime policy identity is invalid/u);
  await rm(policyPath);
  await assert.rejects(readManagedTestPnpmVersion(root), { code: "ENOENT" });
});

// Exercise the real Bun dispatcher and public Foundation quality command, with
// the admitted Node available only on PATH rather than supplied by the caller.
void test("Bun quality dispatch binds its admitted PATH Node into the child environment", async (t) => {
  const runtime = await resolveQualificationExecutables("bun");
  assert.ok(runtime.bun);
  const { writeInstalledRepositoryQualityFixture, writeRuntimeBindingObservationFixture } =
    await import("./support/repository-quality-fixture.mts");
  const root = await mkdtemp(join(profilesTemporaryParent(), "TEST-bun-quality-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeInstalledRepositoryQualityFixture(root, repositoryRoot);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "bun",
    AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: runtime.bun,
    PATH: [dirname(runtime.node), process.env["PATH"] ?? ""].join(delimiter),
  };
  delete environment["AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE"];
  const result = spawnSync(
    runtime.bun,
    [join(repositoryRoot, "tools/repository-command.mts"), "tool", "lint:typed"],
    { cwd: root, env: environment, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /passed/u);
  // The manager/script route must preserve the same verified bindings, too.
  await writeRuntimeBindingObservationFixture(root);
  const scriptResult = spawnSync(
    runtime.bun,
    [join(repositoryRoot, "tools/repository-command.mts"), "script", "check"],
    { cwd: root, env: environment, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(scriptResult.error, undefined);
  assert.equal(scriptResult.status, 0, `${scriptResult.stdout}${scriptResult.stderr}`);
  assert.deepEqual(JSON.parse(await readFile(join(root, "runtime-binding.json"), "utf8")), {
    node: runtime.node,
    bun: runtime.bun,
    leafNodeVersion: "26.11.1",
  });
});

void test("parser spike qualification dispatch uses pinned Node without a package manager", async (t) => {
  const runtime = await resolveQualificationExecutables("bun");
  assert.ok(runtime.bun);
  const root = await mkdtemp(join(profilesTemporaryParent(), "TEST-parser-direct-node-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const observation = join(root, "runtime.json"),
    observer = join(root, "observe.mts");
  await writeFile(
    observer,
    [
      'import { writeFileSync } from "node:fs";',
      `if (process.argv[1] === ${JSON.stringify(join(repositoryRoot, "spikes/source-dependency-parser/run.ts"))}) {`,
      `writeFileSync(${JSON.stringify(observation)}, JSON.stringify({`,
      'execPath: process.execPath, node: process.versions.node, bun: process.versions["bun"] ?? null }));',
      "}",
    ].join("\n"),
  );
  assert.deepEqual(TOOL_COMMANDS["parser-spike:check"], {
    entry: "spikes/source-dependency-parser/run.ts",
    args: ["--verify-only"],
    role: "node-qualification",
  });
  assert.deepEqual(TOOL_COMMANDS["spike:source-parser"], {
    entry: "spikes/source-dependency-parser/run.ts",
    args: [],
    role: "node-qualification",
  });
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    manifest.scripts["parser-spike:check"],
    "node tools/repository-command.mts tool parser-spike:typecheck && node tools/repository-command.mts tool parser-spike:check",
  );
  const compiler = spawnSync(
    runtime.node,
    [join(repositoryRoot, "tools/repository-command.mts"), "tool", "parser-spike:typecheck"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: runtime.node },
    },
  );
  assert.equal(compiler.error, undefined);
  assert.equal(compiler.status, 0, `${compiler.stdout}${compiler.stderr}`);
  const result = spawnSync(
    runtime.bun,
    [join(repositoryRoot, "tools/repository-command.mts"), "tool", "parser-spike:check"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "bun",
        AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: runtime.node,
        AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: runtime.bun,
        NODE_OPTIONS: `--import=${pathToFileURL(observer).href}`,
      },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const report = JSON.parse(result.stdout) as {
    corpusCases: number;
    endToEndExtractionBenchmark?: unknown;
  };
  assert.ok(report.corpusCases > 0);
  assert.equal(report.endToEndExtractionBenchmark, undefined);
  assert.deepEqual(JSON.parse(await readFile(observation, "utf8")), {
    execPath: runtime.node,
    node: "26.11.1",
    bun: null,
  });
});
