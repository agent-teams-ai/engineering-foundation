import assert from "node:assert/strict";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertOwnedProfileRoot } from "../../tools/profile-root.mts";
import {
  resolveQualificationExecutables,
  verifySupportedNode,
  verifyQualificationNode,
} from "../../tools/executable-policy.mts";
import { copySourceTree, sourceTreeDigest } from "../../tools/dev.mts";
import {
  NODE_EXECUTABLE_ENVIRONMENT_VARIABLE,
  requireAdmittedNodeExecutable,
  verifyRepositoryRuntimeExecutable,
} from "../../packages/engineering-foundation/src/process-execution/node-runtime-verifier.ts";
const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

void test("profile roots reject root, siblings, nesting and symlink escapes", async () => {
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
    await symlink(sibling, linked, "junction");
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
        await symlink(foreign, join(workspace, ".worker-tmp/profiles"), "junction");
      } else {
        await symlink(foreign, join(workspace, ".worker-tmp"), "junction");
      }
      const candidate = join(workspace, ".worker-tmp/profiles/victim");
      const before = await readFile(sentinel, "utf8");
      await assert.rejects(
        assertOwnedProfileRoot(candidate, workspace),
        /symbolic link|foreign ancestry|unavailable/u,
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

void test("actual Node 24/26 pass public checks while actual Bun named node is rejected", async (context) => {
  const bun = (await resolveQualificationExecutables("bun")).bun;
  assert.ok(bun !== undefined && bun !== "");
  const node24 =
    process.env["PACK_TEST_GENERATION2_NODE"] ??
    resolve(repositoryRoot, ".cache/public-toolchains/node24/node-v24.18.0-linux-x64/bin/node");
  const node26 = process.execPath;
  assert.equal(
    await isFile(bun),
    true,
    "The selected Bun binary must exist for identity rejection.",
  );
  const hasNode24 = await isFile(node24);
  if (!hasNode24) {
    context.diagnostic(
      "Optional owned Node24 binary is absent; Node26 and wrong-identity Bun checks still execute.",
    );
  }
  const root = await mkdtemp(join(profilesTemporaryParent(), "runtime-identity-"));
  const renamedBun = join(root, process.platform === "win32" ? "node.exe" : "node");
  try {
    await link(bun, renamedBun).catch(async (error: unknown) => {
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "EXDEV" || error.code === "EPERM")
        )
      ) {
        throw error;
      }
      await copyFile(bun, renamedBun);
    });

    assert.equal(await verifyRepositoryRuntimeExecutable(node26, "node"), true);
    assert.equal(await verifyRepositoryRuntimeExecutable(renamedBun, "node"), false);
    assert.throws(
      () =>
        requireAdmittedNodeExecutable(
          {
            [NODE_EXECUTABLE_ENVIRONMENT_VARIABLE]: renamedBun,
          },
          node26,
        ),
      /supported public Node executable/u,
    );

    assert.equal(await verifySupportedNode(node26), node26);
    assert.equal(await verifyQualificationNode(node26), node26);
    if (hasNode24) {
      assert.equal(await verifyRepositoryRuntimeExecutable(node24, "node"), true);
      assert.equal(
        requireAdmittedNodeExecutable(
          {
            [NODE_EXECUTABLE_ENVIRONMENT_VARIABLE]: node24,
          },
          node26,
        ),
        await realpath(node24),
      );
      assert.equal(await verifySupportedNode(node24), node24);
      await assert.rejects(verifyQualificationNode(node24), /admitted Node 26\.11\.1/u);
    }
    await assert.rejects(verifySupportedNode(renamedBun), /supported public Node runtime/u);
    await assert.rejects(verifyQualificationNode(renamedBun), /admitted Node 26\.11\.1/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("explicit unavailable runtimes reject instead of falling back to ambient tools", async () => {
  const previous = process.env["AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE"];
  try {
    process.env["AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE"] = join(
      repositoryRoot,
      "missing-explicit-node",
    );
    await assert.rejects(resolveQualificationExecutables("node"), /not admitted Node 26\.11\.1/u);
  } finally {
    if (previous === undefined) {
      delete process.env["AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE"];
    } else {
      process.env["AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE"] = previous;
    }
  }
});

void test("source digest and copied profiles ignore generated/cache churn but preserve real inputs", async () => {
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
    await writeFile(join(first, "package.json"), '{"packageManager":"bun@1.4.3"}\n');
    await writeFile(join(first, "foundation.config.yaml"), "defaultProfile: bun\n");
    await mkdir(join(first, "packages/example"), { recursive: true });
    await writeFile(join(first, "packages/example/src.mts"), "export const source = true;\n");
    await writeFile(join(first, "z.txt"), "z\n");
    await writeFile(join(first, "a.txt"), "a\n");
    await writeFile(join(second, "a.txt"), "a\n");
    await writeFile(join(second, "z.txt"), "z\n");
    await writeFile(join(second, "package.json"), '{"packageManager":"bun@1.4.3"}\n');
    await writeFile(join(second, "foundation.config.yaml"), "defaultProfile: bun\n");
    await mkdir(join(second, "packages/example"), { recursive: true });
    await writeFile(join(second, "packages/example/src.mts"), "export const source = true;\n");
    for (const root of [first, second]) {
      await writeFile(join(root, ".pnpm-store/churn"), "ignored\n");
      await writeFile(join(root, ".nx/cache/local-generated/churn"), "ignored\n");
      await writeFile(
        join(root, ".worker-tmp/installed-dependencies.json"),
        '{"generated":true}\n',
      );
      await writeFile(join(root, "packages/example/dist/churn"), "ignored\n");
      await writeFile(join(root, "coverage/churn"), "ignored\n");
      await writeFile(join(root, "incremental.tsbuildinfo"), "ignored\n");
      await writeFile(join(root, ".agent-teams-runtime-profile.json"), '{"generated":true}\n');
    }

    const initialFirst = await sourceTreeDigest(first);
    const initialSecond = await sourceTreeDigest(second);
    assert.equal(initialFirst, initialSecond);
    await writeFile(join(first, ".pnpm-store/changed"), "ignored again\n");
    await writeFile(join(first, ".nx/cache/local-generated/changed"), "ignored again\n");
    await writeFile(join(first, ".worker-tmp/changed"), "ignored again\n");
    await writeFile(join(first, ".agent-teams-runtime-profile.json"), '{"generated":"changed"}\n');
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
    assert.equal(
      await readFile(join(copied, "packages/example/src.mts"), "utf8"),
      "export const source = false;\n",
    );
    assert.equal(
      await readFile(join(copied, "foundation.config.yaml"), "utf8"),
      "defaultProfile: node\n",
    );
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
    await rm(copied, { recursive: true, force: true });
  }
});

export async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (metadata) => metadata.isFile(),
    () => false,
  );
}

export function profilesTemporaryParent(): string {
  return resolve(repositoryRoot, ".worker-tmp/profiles");
}
