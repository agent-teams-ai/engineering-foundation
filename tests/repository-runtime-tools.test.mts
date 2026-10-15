import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, cp, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertOwnedProfileRoot } from "../tools/profile-root.mts";
import { inspectInstalledDependencies } from "../tools/dependencies-installed-check.mts";
import { checkEngineeringQualityStandard } from "../scripts/check-engineering-quality-standard.mts";
import {
  resolveQualificationExecutables,
  verifyQualificationNode,
  verifySupportedNode
} from "../tools/executable-policy.mts";
import { copySourceTree, sourceTreeDigest } from "../tools/dev.mts";
import { resolveNodeToolInvocation } from "../tools/repository-command.mts";
import {
  requireAdmittedNodeExecutable,
  verifyAdmittedRuntimeExecutable
} from "../packages/engineering-foundation/src/process-execution/node-runtime-verifier.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("profile roots reject root, siblings, nesting and symlink escapes", async () => {
  const profiles = resolve(repositoryRoot, ".worker-tmp/profiles");
  await mkdir(profiles, { recursive: true });
  const accepted = join(profiles, `runtime-root-${process.pid}`);
  const sibling = resolve(repositoryRoot, ".worker-tmp/profiles-other");
  const nested = join(accepted, "nested");
  const linked = join(profiles, `runtime-link-${process.pid}`);
  const fixture = join(profiles, `TEST-profile-parent-${process.pid}`);
  try {
    await mkdir(accepted);
    await mkdir(nested, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await symlink(sibling, linked);
    assert.equal(await assertOwnedProfileRoot(accepted), accepted);
    await assert.rejects(assertOwnedProfileRoot(repositoryRoot), /one dedicated child/u);
    await assert.rejects(assertOwnedProfileRoot(sibling), /one dedicated child/u);
    await assert.rejects(assertOwnedProfileRoot(nested), /one dedicated child/u);
    await assert.rejects(assertOwnedProfileRoot(linked), /symbolic link/u);

    for (const linkedParent of ["profiles", ".worker-tmp"]) {
      const workspace = join(fixture, `workspace-${linkedParent.replace(".", "")}`);
      const foreign = join(fixture, `foreign-${linkedParent.replace(".", "")}`);
      await mkdir(workspace, { recursive: true });
      await mkdir(foreign, { recursive: true });
      const sentinel = join(foreign, "sentinel.txt");
      await writeFile(sentinel, `${linkedParent} test sibling must remain unchanged\n`);
      if (linkedParent === "profiles") {
        await mkdir(join(workspace, ".worker-tmp"));
        await symlink(foreign, join(workspace, ".worker-tmp/profiles"));
      } else {
        await symlink(foreign, join(workspace, ".worker-tmp"));
      }
      const candidate = join(workspace, ".worker-tmp/profiles/victim");
      const before = await readFile(sentinel, "utf8");
      await assert.rejects(
        assertOwnedProfileRoot(candidate, workspace),
        /symbolic link|foreign ancestry|unavailable/u
      );
      assert.equal(await readFile(sentinel, "utf8"), before);
    }
  } finally {
    await rm(linked, { force: true });
    await rm(nested, { recursive: true, force: true });
    await rm(accepted, { recursive: true, force: true });
    await rm(sibling, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});

test("actual Node 24/26 pass public checks while actual Bun named node is rejected", async (context) => {
  const bun = resolve(repositoryRoot, ".cache/public-toolchains/bun/bun");
  const node24 = resolve(
    repositoryRoot,
    ".cache/public-toolchains/node24/node-v24.18.0-linux-x64/bin/node"
  );
  const node26 = process.execPath;
  if (!await isFile(bun) || !await isFile(node24)) {
    context.skip("owned Node 24 and Bun TEST toolchains are unavailable");
    return;
  }
  const root = await mkdtemp(join(profilesTemporaryParent(), "runtime-identity-"));
  const renamedBun = join(root, "node");
  try {
    await link(bun, renamedBun).catch(async (error) => {
      if (error?.code !== "EXDEV" && error?.code !== "EPERM") {
        throw error;
      }
      await copyFile(bun, renamedBun);
    });

    assert.equal(await verifyAdmittedRuntimeExecutable(node24), true);
    assert.equal(await verifyAdmittedRuntimeExecutable(node26), true);
    assert.equal(await verifyAdmittedRuntimeExecutable(renamedBun), false);
    assert.equal(requireAdmittedNodeExecutable({
      AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: node24
    }, node26), node24);
    assert.throws(
      () => requireAdmittedNodeExecutable({
        AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: renamedBun
      }, node26),
      /supported public Node executable/u
    );

    assert.equal(await verifySupportedNode(node24), node24);
    assert.equal(await verifySupportedNode(node26), node26);
    await assert.rejects(verifyQualificationNode(node24), /admitted Node 26\.11\.1/u);
    assert.equal(await verifyQualificationNode(node26), node26);
    await assert.rejects(verifySupportedNode(renamedBun), /supported public Node runtime/u);
    await assert.rejects(verifyQualificationNode(renamedBun), /admitted Node 26\.11\.1/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pnpm launcher verifies the actual manager and ignores ambient npm_execpath", async (context) => {
  const pnpm = resolve(repositoryRoot, ".cache/public-toolchains/pnpm/pnpm.mjs");
  const bun = resolve(repositoryRoot, ".cache/public-toolchains/bun/bun");
  if (!await isFile(pnpm) || !await isFile(bun)) {
    context.skip("owned pnpm and Bun TEST toolchains are unavailable");
    return;
  }
  const root = await mkdtemp(join(profilesTemporaryParent(), "pnpm-manager-"));
  const project = join(root, "project");
  const bin = join(root, "bin");
  const tmp = join(root, "tmp");
  const wrong = join(root, "wrong-manager.cjs");
  const ambientPnpm = join(bin, "pnpm.mjs");
  try {
    await mkdir(project);
    await mkdir(bin);
    await mkdir(tmp);
    await writeFile(join(project, "package.json"), `${JSON.stringify({
      packageManager: "pnpm@11.20.0",
      scripts: { "verify-manager": "node manager.cjs" }
    }, null, 2)}\n`);
    await writeFile(
      join(project, "manager.cjs"),
      "require(\"node:fs\").writeFileSync(\"manager-ran.txt\", \"pnpm\");\n"
    );
    await writeFile(
      join(project, ".npmrc"),
      "ignore-workspace=true\npm-on-fail=ignore\nverify-deps-before-run=false\n",
      "utf8"
    );
    await writeFile(wrong, [
      "const fs = require(\"node:fs\");",
      "if (process.argv.includes(\"run\")) fs.writeFileSync(\"wrong-real-operation.txt\", \"wrong\");",
      "console.log(\"99.0.0\");"
    ].join("\n"));
    await link(pnpm, ambientPnpm).catch(async (error) => {
      if (error?.code !== "EXDEV" && error?.code !== "EPERM") {
        throw error;
      }
      await copyFile(pnpm, ambientPnpm);
    });

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
        PATH: `${bin}:${process.env["PATH"] ?? ""}`
      };
      const rejected = spawnSync(
        launcher,
        [resolve(repositoryRoot, "tools/pnpm-command.mts"), "run", "verify-manager"],
        { cwd: project, encoding: "utf8", env: environment, timeout: 10_000 }
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
          timeout: 10_000
        }
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

test("source digest and copied profiles ignore generated/cache churn but preserve real inputs", async () => {
  const first = await mkdtemp(join(profilesTemporaryParent(), "source-digest-a-"));
  const second = await mkdtemp(join(profilesTemporaryParent(), "source-digest-b-"));
  const copied = await mkdtemp(join(profilesTemporaryParent(), "source-copy-"));
  try {
    for (const root of [first, second]) {
      await mkdir(join(root, ".pnpm-store"));
      await mkdir(join(root, ".nx/cache/local-generated"), { recursive: true });
      await mkdir(join(root, ".worker-tmp"), { recursive: true });
      await mkdir(join(root, "packages/example/dist"), { recursive: true });
      await mkdir(join(root, "coverage"));
    }
    await writeFile(join(first, "package.json"), "{\"packageManager\":\"bun@1.4.3\"}\n");
    await writeFile(join(first, "foundation.config.yaml"), "defaultProfile: bun\n");
    await mkdir(join(first, "packages/example"), { recursive: true });
    await writeFile(join(first, "packages/example/src.mts"), "export const source = true;\n");
    await writeFile(join(first, "z.txt"), "z\n");
    await writeFile(join(first, "a.txt"), "a\n");
    await writeFile(join(second, "a.txt"), "a\n");
    await writeFile(join(second, "z.txt"), "z\n");
    await writeFile(join(second, "package.json"), "{\"packageManager\":\"bun@1.4.3\"}\n");
    await writeFile(join(second, "foundation.config.yaml"), "defaultProfile: bun\n");
    await mkdir(join(second, "packages/example"), { recursive: true });
    await writeFile(join(second, "packages/example/src.mts"), "export const source = true;\n");
    for (const root of [first, second]) {
      await writeFile(join(root, ".pnpm-store/churn"), "ignored\n");
      await writeFile(join(root, ".nx/cache/local-generated/churn"), "ignored\n");
      await writeFile(join(root, ".worker-tmp/installed-dependencies.json"), "{\"generated\":true}\n");
      await writeFile(join(root, "packages/example/dist/churn"), "ignored\n");
      await writeFile(join(root, "coverage/churn"), "ignored\n");
      await writeFile(join(root, "incremental.tsbuildinfo"), "ignored\n");
      await writeFile(join(root, ".agent-teams-runtime-profile.json"), "{\"generated\":true}\n");
    }

    const initialFirst = await sourceTreeDigest(first);
    const initialSecond = await sourceTreeDigest(second);
    assert.equal(initialFirst, initialSecond);
    await writeFile(join(first, ".pnpm-store/changed"), "ignored again\n");
    await writeFile(join(first, ".nx/cache/local-generated/changed"), "ignored again\n");
    await writeFile(join(first, ".worker-tmp/changed"), "ignored again\n");
    await writeFile(join(first, ".agent-teams-runtime-profile.json"), "{\"generated\":\"changed\"}\n");
    await writeFile(join(first, "packages/example/dist/changed"), "ignored again\n");
    assert.equal(await sourceTreeDigest(first), initialFirst);
    await writeFile(join(first, "packages/example/src.mts"), "export const source = false;\n");
    await writeFile(join(first, "foundation.config.yaml"), "defaultProfile: node\n");
    assert.notEqual(await sourceTreeDigest(first), initialFirst);

    await copySourceTree(first, copied);
    assert.equal(await isFile(join(copied, "packages/example/dist/churn")), false);
    assert.equal(await isFile(join(copied, ".agent-teams-runtime-profile.json")), false);
    assert.equal(await isFile(join(copied, ".nx/cache/local-generated/churn")), false);
    assert.equal(await isFile(join(copied, ".worker-tmp/installed-dependencies.json")), false);
    assert.equal(await readFile(join(copied, "packages/example/src.mts"), "utf8"), "export const source = false;\n");
    assert.equal(await readFile(join(copied, "foundation.config.yaml"), "utf8"), "defaultProfile: node\n");
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
    await rm(copied, { recursive: true, force: true });
  }
});

test("extensionless fixed JS tools use the explicitly admitted Node executable", async (context) => {
  if (process.platform !== "linux") {
    context.skip("Linux focused proof; native Windows qualification remains pending");
    return;
  }
  const root = await mkdtemp(join(profilesTemporaryParent(), "poisoned-path-"));
  const poisonBin = join(root, "bin");
  const poisonMarker = join(root, "poison-node-ran");
  const fixture = join(root, "fixture");
  try {
    const { bun } = await resolveQualificationExecutables("bun");
    assert.ok(bun !== undefined, "repository executable policy must supply admitted Bun");
    await mkdir(poisonBin);
    await mkdir(fixture);
    await writeFile(join(poisonBin, "node"), [
      "#!/bin/sh",
      `printf poisoned > ${JSON.stringify(poisonMarker)}`,
      "exit 97"
    ].join("\n"), { mode: 0o755 });
    await writeFile(join(fixture, "tsconfig.ci-tooling.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext" },
      files: ["index.ts"]
    }, null, 2));
    await writeFile(join(fixture, "index.ts"), "export const value: number = 1;\n");
    const tscEntry = resolve(repositoryRoot, "node_modules/typescript/bin/tsc");
    const typecheckArgs = ["--project", "tsconfig.ci-tooling.json"];
    const environment = {
      ...process.env,
      AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: process.execPath,
      AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: bun,
      AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "bun",
      PATH: poisonBin
    };

    // The historical suffix/direct-spawn behavior is exercised semantically:
    // the extensionless package entry must fail when PATH's Node is poisoned.
    const oldDirect = spawnSync(tscEntry, typecheckArgs, {
      cwd: fixture,
      encoding: "utf8",
      env: environment,
      timeout: 10_000
    });
    assert.equal(oldDirect.status, 97, `${oldDirect.stdout}${oldDirect.stderr}`);
    assert.equal(await isFile(poisonMarker), true);
    await rm(poisonMarker, { force: true });

    const result = spawnSync(
      bun,
      [resolve(repositoryRoot, "tools/repository-command.mts"), "tool", "typecheck:ci-tooling"],
      {
        cwd: fixture,
        encoding: "utf8",
        env: environment,
        timeout: 30_000
      }
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(await isFile(poisonMarker), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("esbuild qualification uses its supported package entry in an isolated owner layout", async () => {
  const fixture = await mkdtemp(join(profilesTemporaryParent(), "esbuild-owner-"));
  const supportedEntry = join(fixture, "node_modules/esbuild/bin/esbuild");
  try {
    const testRequire = createRequire(import.meta.url);
    const esbuildManifestPath = testRequire.resolve("esbuild/package.json");
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
      force: true
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

    assert.ok(installedOwners.length > 0, "the installed esbuild graph must contain an optional native owner");
    assert.equal(await isFile(supportedEntry), true);
    assert.equal(await isPresent(join(fixture, "node_modules/@esbuild")), false);
    const invocation = resolveNodeToolInvocation(supportedEntry, ["--version"], [], process.execPath);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: fixture,
      encoding: "utf8",
      env: { ...process.env, AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: process.execPath },
      timeout: 10_000
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /0\.28\.2/u);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (metadata) => metadata.isFile(),
    () => false
  );
}

async function isPresent(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

async function writeManifest(path: string, manifest: unknown): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

test("installed guard validates optional peer ranges and follows peer-only engine context", async () => {
  const root = await mkdtemp(join(profilesTemporaryParent(), "installed-guard-"));
  try {
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n", "utf8");
    await writeManifest(root, {
      name: "fixture-root",
      version: "1.0.0",
      dependencies: { host: "1.0.0", "optional-host": "1.0.0" }
    });
    await writeManifest(join(root, "node_modules/host"), {
      name: "host",
      version: "1.0.0",
      peerDependencies: { peer: "^2.0.0" }
    });
    await writeManifest(join(root, "node_modules/host/node_modules/peer"), {
      name: "peer",
      version: "2.0.0",
      engines: { node: ">=99.0.0" }
    });
    await writeManifest(join(root, "node_modules/optional-host"), {
      name: "optional-host",
      version: "1.0.0",
      peerDependencies: { absent: "not-a-range" },
      peerDependenciesMeta: { absent: { optional: true } }
    });
    await assert.rejects(
      inspectInstalledDependencies(root),
      /Malformed SemVer range.*absent/u
    );
    await writeManifest(join(root, "node_modules/optional-host"), {
      name: "optional-host",
      version: "1.0.0",
      peerDependencies: { absent: "^1.0.0" },
      peerDependenciesMeta: { absent: { optional: true } }
    });
    await assert.rejects(
      inspectInstalledDependencies(root),
      /Installed engine mismatch.*peer@2\.0\.0/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("standards pin gate rejects consumer classification drift", async () => {
  const root = await mkdtemp(join(profilesTemporaryParent(), "standards-pin-"));
  try {
    await mkdir(join(root, "standards"), { recursive: true });
    for (const file of [
      "engineering-quality-standard.md",
      "engineering-quality-standard.provenance.json",
      "standards-pin-review.json"
    ]) {
      await writeFile(
        join(root, "standards", file),
        await readFile(join(repositoryRoot, "standards", file), "utf8")
      );
    }
    await checkEngineeringQualityStandard(root);
    const reviewPath = join(root, "standards/standards-pin-review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf8")) as {
      readonly classification: Record<string, string>;
    };
    review.classification["consumerModuleStandard"] = "adopted";
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
    await assert.rejects(
      checkEngineeringQualityStandard(root),
      /classification drifted/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function profilesTemporaryParent(): string {
  return resolve(repositoryRoot, ".worker-tmp/profiles");
}
