import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolvePnpmInvocation } from "../tools/pnpm-command.mts";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (metadata) => metadata.isFile(),
    () => false,
  );
}

test("manager admission survives injected npm config env-replacement noise", async (context) => {
  const manager = await resolvePnpmInvocation(process.execPath, "11.20.0");
  const pnpm = manager.kind === "javascript" ? manager.args[0] : manager.command;
  assert.ok(pnpm);
  if (!(await isFile(pnpm))) {
    context.skip("owned pnpm TEST toolchain is unavailable");
    return;
  }
  const parent = resolve(repositoryRoot, ".worker-tmp/profiles");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "pnpm-config-noise-"));
  try {
    // setup-node registry scaffolding leaves an unresolvable ${NODE_AUTH_TOKEN} in
    // the injected user config; pnpm reports it to stderr and manager admission
    // must not treat that caller-config noise as entrypoint identity.
    const userNpmrc = join(root, "user.npmrc");
    await writeFile(
      userNpmrc,
      "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n",
      "utf8",
    );
    const result = spawnSync(
      process.execPath,
      [resolve(repositoryRoot, "tools/pnpm-command.mts"), "--version"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: process.execPath,
          AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT: pnpm,
          NPM_CONFIG_USERCONFIG: userNpmrc,
          npm_config_userconfig: userNpmrc,
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(result.stdout.trim(), "11.20.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
