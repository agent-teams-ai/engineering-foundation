import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertOwnedProfileRoot } from "../tools/profile-root.mts";
import { inspectInstalledDependencies } from "../tools/dependencies-installed-check.mts";
import { checkEngineeringQualityStandard } from "../scripts/check-engineering-quality-standard.mts";
import { verifyQualificationNode, verifySupportedNode } from "../tools/executable-policy.mts";
import { sourceTreeDigest } from "../tools/dev.mts";
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

test("source digest is deterministic and ignores owned cache/build churn", async () => {
  const first = await mkdtemp(join(profilesTemporaryParent(), "source-digest-a-"));
  const second = await mkdtemp(join(profilesTemporaryParent(), "source-digest-b-"));
  try {
    for (const root of [first, second]) {
      await mkdir(join(root, ".pnpm-store"));
      await mkdir(join(root, "packages/example/dist"), { recursive: true });
      await mkdir(join(root, "coverage"));
    }
    await writeFile(join(first, "package.json"), "{\"packageManager\":\"bun@1.4.3\"}\n");
    await writeFile(join(first, "z.txt"), "z\n");
    await writeFile(join(first, "a.txt"), "a\n");
    await writeFile(join(second, "a.txt"), "a\n");
    await writeFile(join(second, "z.txt"), "z\n");
    await writeFile(join(second, "package.json"), "{\"packageManager\":\"bun@1.4.3\"}\n");
    for (const root of [first, second]) {
      await writeFile(join(root, ".pnpm-store/churn"), "ignored\n");
      await writeFile(join(root, "packages/example/dist/churn"), "ignored\n");
      await writeFile(join(root, "coverage/churn"), "ignored\n");
      await writeFile(join(root, "incremental.tsbuildinfo"), "ignored\n");
    }

    const initialFirst = await sourceTreeDigest(first);
    const initialSecond = await sourceTreeDigest(second);
    assert.equal(initialFirst, initialSecond);
    await writeFile(join(first, ".pnpm-store/changed"), "ignored again\n");
    await writeFile(join(first, "packages/example/dist/changed"), "ignored again\n");
    assert.equal(await sourceTreeDigest(first), initialFirst);
    await writeFile(join(first, "a.txt"), "changed input\n");
    assert.notEqual(await sourceTreeDigest(first), initialFirst);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (metadata) => metadata.isFile(),
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
