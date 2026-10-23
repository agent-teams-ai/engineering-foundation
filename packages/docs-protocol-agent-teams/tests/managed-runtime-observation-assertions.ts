import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsPromises, {
  chmod,
  copyFile,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import type { TestContext } from "node:test";
import { fixture, negativePackageSelection } from "./managed-runtime-fixtures.mjs";
import type { ManagedRuntimeFixture } from "./managed-runtime-fixtures.mjs";
import { createNodeManagedRuntimeScope } from "../dist/consumer-integration/adapters/node-managed-runtime.js";
function requireRefusal<T extends { outcome: string }>(
  result: T,
): Extract<T, { outcome: "refused" }> {
  assert.ok(result.outcome === "refused", JSON.stringify(result));
  return result as Extract<T, { outcome: "refused" }>;
}
// A bound synthetic package tests refusal boundaries; it is never actual pnpm qualification.
export async function negativeObservationFixture() {
  const f = await fixture("node24");
  const manifest = `${f.packageRoot}/package.json`;
  const parsed = JSON.parse(await readFile(manifest, "utf8")) as Record<string, unknown>;
  parsed.version = "11.20.0";
  await writeFile(manifest, JSON.stringify(parsed));
  await writeFile(`${f.packageRoot}/bin/pnpm.mjs`, 'process.stdout.write("11.20.0\\n")');
  const negative = await negativePackageSelection(f);
  const manifestSha = createHash("sha256")
    .update(await readFile(manifest))
    .digest("hex");
  return {
    ...f,
    selection: {
      ...negative,
      pnpmPackage: { ...negative.pnpmPackage, expectedManifestSha256: manifestSha },
    },
  };
}

export async function assertSelectedExecutableIdentity(): Promise<void> {
  const f = await fixture("node24");
  const signal = new AbortController().signal;
  try {
    const alias = `${f.root}/node-link`;
    await symlink(f.node, alias);
    const aliasScope = createNodeManagedRuntimeScope({
      privateRoot: f.root,
      selection: { ...f.selection, selectedNode: { ...f.selection.selectedNode, path: alias } },
      signal,
    });
    assert.equal(requireRefusal(await aliasScope.admit()).code, "identity-changed");
    const packageAlias = `${f.root}/pnpm-link`;
    await symlink(f.packageRoot, packageAlias);
    const packageScope = createNodeManagedRuntimeScope({
      privateRoot: f.root,
      selection: {
        ...f.selection,
        pnpmPackage: { ...f.selection.pnpmPackage, root: packageAlias },
      },
      signal,
    });
    assert.equal(requireRefusal(await packageScope.admit()).code, "identity-changed");
    const changed = createNodeManagedRuntimeScope({
      privateRoot: f.root,
      selection: f.selection,
      signal,
    });
    await writeFile(f.node, "not the selected node");
    assert.equal(requireRefusal(await changed.admit()).code, "identity-changed");
    assert.equal((await changed.close()).outcome, "closed");
  } finally {
    await f.cleanup();
  }
}

export async function assertUnsafeRuntimeInventory(t: TestContext): Promise<void> {
  const cases: [string, (f: ManagedRuntimeFixture) => Promise<void>][] = [
    [
      "same-version bin shim",
      async (f) => writeFile(`${f.packageRoot}/bin/pnpm.mjs`, 'process.stdout.write("11.20.0\\n")'),
    ],
    [
      "hardlinked Node copy",
      async (f) => {
        const other = `${f.root}/other-node`;
        await copyFile(f.node, other);
        await unlink(f.node);
        await link(other, f.node);
      },
    ],
    ["oversized Node copy", async (f) => truncate(f.node, 256 * 1024 * 1024 + 1)],
    ["missing Node copy", async (f) => unlink(f.node)],
    ["package tree symlink", async (f) => symlink(f.node, `${f.packageRoot}/unexpected-link`)],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const f = await fixture("node24");
      try {
        await mutate(f);
        const scope = createNodeManagedRuntimeScope({
          privateRoot: f.root,
          selection: f.selection,
          signal: new AbortController().signal,
        });
        assert.equal(requireRefusal(await scope.admit()).code, "identity-changed");
        assert.equal((await scope.close()).outcome, "closed");
      } finally {
        await f.cleanup();
      }
    });
  }
}

export async function assertPackageReplacementIdentity(): Promise<void> {
  const f = await fixture("node24");
  const signal = new AbortController().signal;
  const scope = createNodeManagedRuntimeScope({
    privateRoot: f.root,
    selection: f.selection,
    signal,
  });
  try {
    const admitted = await scope.admit();
    assert.equal(admitted.outcome, "admitted");
    const bundle = `${f.packageRoot}/dist/pnpm.mjs`;
    await copyFile(bundle, `${bundle}.replacement`);
    await rename(`${bundle}.replacement`, bundle);
    const result = await scope.observe({
      runtime: admitted.runtime,
      expected: f.expected,
      signal,
    });
    assert.equal(requireRefusal(result).code, "identity-changed");
    assert.equal(result.facts.spawned, false);
    assert.equal((await scope.close()).outcome, "closed");
  } finally {
    await f.cleanup();
  }
}

export async function assertReturnedEvidenceIsolation(): Promise<void> {
  const f = await negativeObservationFixture();
  const signal = new AbortController().signal;
  const scope = createNodeManagedRuntimeScope({
    privateRoot: f.root,
    selection: f.selection,
    signal,
  });
  try {
    const admitted = await scope.admit();
    assert.equal(admitted.outcome, "admitted");
    const first = await scope.observe({
      runtime: admitted.runtime,
      expected: f.expected,
      signal,
    });
    assert.equal(first.outcome, "observed", JSON.stringify(first));
    await copyFile(f.node, `${f.node}.replacement`);
    await rename(`${f.node}.replacement`, f.node);
    const replacement = await stat(f.node, { bigint: true });
    Object.assign(first.observation.node, {
      inode: replacement.ino.toString(),
      device: replacement.dev.toString(),
      birthtimeNs: replacement.birthtimeNs.toString(),
      ctimeNs: replacement.ctimeNs.toString(),
      mtimeNs: replacement.mtimeNs.toString(),
    });
    Object.assign(first.observation.tuple, { nodeVersion: "26.10.0" });
    Object.assign(first.observation.pnpm.manifest, { sha256: "0".repeat(64) });
    const result = await scope.observe({
      runtime: admitted.runtime,
      expected: f.expected,
      signal,
    });
    assert.equal(requireRefusal(result).code, "identity-changed", JSON.stringify(result));
    assert.equal(result.facts.spawned, false);
    assert.equal((await scope.close()).outcome, "closed");
  } finally {
    await f.cleanup();
  }
}

export async function assertMalformedObservationStderr(): Promise<void> {
  const f = await negativeObservationFixture();
  await writeFile(
    `${f.packageRoot}/bin/pnpm.mjs`,
    'process.stderr.write(Buffer.from([255])); process.stdout.write("11.20.0\\n")',
  );
  const rebound = await negativePackageSelection(f);
  const selection = {
    ...f.selection,
    pnpmPackage: {
      ...rebound.pnpmPackage,
      expectedManifestSha256: f.selection.pnpmPackage.expectedManifestSha256,
    },
  };
  const signal = new AbortController().signal;
  const scope = createNodeManagedRuntimeScope({ privateRoot: f.root, selection, signal });
  try {
    const admitted = await scope.admit();
    assert.equal(admitted.outcome, "admitted");
    const result = await scope.observe({ runtime: admitted.runtime, expected: f.expected, signal });
    assert.equal(result.outcome, "refused");
    assert.equal(requireRefusal(result).code, "invalid-output", JSON.stringify(result));
    assert.equal(result.facts.group, "empty-observed");
    assert.equal(result.debt, null);
    assert.equal((await scope.close()).outcome, "closed");
  } finally {
    await f.cleanup();
  }
}

export async function assertAbortedAdmissionDebt(): Promise<void> {
  const f = await negativeObservationFixture();
  const controller = new AbortController();
  const scope = createNodeManagedRuntimeScope({
    privateRoot: f.root,
    selection: f.selection,
    signal: controller.signal,
  });
  const originalLstat = fsPromises.lstat;
  let substituted: string | null = null;
  try {
    fsPromises.lstat = (async (...args: Parameters<typeof fsPromises.lstat>) => {
      const info = await originalLstat(...args);
      if (
        (substituted === null || substituted.length === 0) &&
        typeof args[0] === "string" &&
        args[0].startsWith(`${f.root}/managed-runtime-`)
      ) {
        substituted = args[0];
        await rename(substituted, `${substituted}.original`);
        await mkdir(substituted);
        await writeFile(`${substituted}/FOREIGN-SENTINEL`, "foreign fixture data");
        controller.abort();
      }
      return info;
    }) as typeof fsPromises.lstat;
    syncBuiltinESMExports();
    const result = await scope.admit();
    assert.equal(result.outcome, "refused");
    assert.equal(requireRefusal(result).code, "cleanup-failed", JSON.stringify(result));
    assert.equal(requireRefusal(result).debt!.attemptId, substituted);
    assert.equal((await stat(`${substituted}/FOREIGN-SENTINEL`)).isFile(), true);
    assert.equal((await scope.close()).outcome, "debt");
  } finally {
    fsPromises.lstat = originalLstat;
    syncBuiltinESMExports();
    await f.cleanup();
  }
}

export async function assertPostLaunchPackageIdentity(): Promise<void> {
  const f = await fixture("node24");
  const entry = `${f.packageRoot}/bin/pnpm.mjs`;
  await writeFile(
    entry,
    `import { watch, writeFileSync } from 'node:fs';
    const watcher = watch('.', (_event, name) => {
      if (name === 'release') {watcher.close(); process.stdout.write('11.20.0\\n');}
    });
    writeFileSync('ready', '1');`,
  );
  const selection = await negativePackageSelection(f);
  const signal = new AbortController().signal;
  const scope = createNodeManagedRuntimeScope({ privateRoot: f.root, selection, signal });
  let watcher: FSWatcher | undefined;
  try {
    const admitted = await scope.admit();
    assert.equal(admitted.outcome, "admitted");
    const owned = `${f.root}/${(await readdir(f.root)).find((name) => name.startsWith("managed-runtime-"))}`;
    const ready = new Promise<void>((resolve) => {
      watcher = watch(owned, (_event, name) => {
        if (name === "ready") {
          resolve();
        }
      });
    });
    const observing = scope.observe({ runtime: admitted.runtime, expected: f.expected, signal });
    const first = await Promise.race([
      ready.then(() => ({ kind: "ready" })),
      observing.then((result) => ({ kind: "settled", result })),
    ]);
    assert.equal(first.kind, "ready", JSON.stringify(first));
    await writeFile(`${f.packageRoot}/dist/pnpm.mjs`, "test-owned changed bundle");
    await writeFile(`${owned}/release`, "1");
    const result = await observing;
    assert.equal(
      requireRefusal(result).code,
      "identity-changed",
      JSON.stringify({ code: requireRefusal(result).code, facts: result.facts }),
    );
    assert.equal(result.facts.directChild, "reaped");
    assert.equal(result.facts.group, "empty-observed");
    assert.equal((await scope.close()).outcome, "closed");
  } finally {
    watcher?.close();
    await scope.close();
    await f.cleanup();
  }
}

export async function assertWrongPnpmVersion(): Promise<void> {
  const f = await fixture("node24");
  await writeFile(`${f.packageRoot}/bin/pnpm.mjs`, 'process.stdout.write("11.19.0\\n")');
  const selection = await negativePackageSelection(f);
  const signal = new AbortController().signal;
  const scope = createNodeManagedRuntimeScope({ privateRoot: f.root, selection, signal });
  try {
    const admitted = await scope.admit();
    assert.equal(admitted.outcome, "admitted");
    const result = await scope.observe({
      runtime: admitted.runtime,
      expected: f.expected,
      signal,
    });
    assert.equal(requireRefusal(result).code, "runtime-mismatch");
    assert.equal(result.facts.group, "empty-observed");
    assert.equal((await scope.close()).outcome, "closed");
  } finally {
    await f.cleanup();
  }
}

export async function assertObservationCloseCancellation(): Promise<void> {
  const f = await fixture("node24");
  const signal = new AbortController().signal;
  const scope = createNodeManagedRuntimeScope({
    privateRoot: f.root,
    selection: f.selection,
    signal,
  });
  try {
    const admitted = await scope.admit();
    assert.equal(admitted.outcome, "admitted");
    const running = scope.observe({ runtime: admitted.runtime, expected: f.expected, signal });
    const closing = scope.close();
    const result = await running;
    assert.equal(result.outcome, "refused");
    assert.equal(requireRefusal(result).code, "cancelled");
    assert.equal((await closing).outcome, "closed");
  } finally {
    await f.cleanup();
  }
}

export async function assertDeniedCleanupDebt(): Promise<void> {
  process.umask(0o022);
  const f = await fixture("node24");
  const signal = new AbortController().signal;
  const scope = createNodeManagedRuntimeScope({
    privateRoot: f.root,
    selection: f.selection,
    signal,
  });
  let owned: string | undefined;
  try {
    assert.equal((await scope.admit()).outcome, "admitted");
    owned = `${f.root}/${(await readdir(f.root)).find((name) => name.startsWith("managed-runtime-"))}`;
    await writeFile(`${owned}/retained`, "test-owned");
    await chmod(owned, 0o000);
    await assert.rejects(writeFile(`${owned}/denied`, "x"), { code: "EACCES" });
    const closed = await scope.close();
    assert.equal(closed.outcome, "debt");
    assert.equal(closed.debt.code, "cleanup-failed");
    assert.equal(closed.debt.attemptId, owned);
  } finally {
    if (owned !== undefined && owned.length > 0) {
      await chmod(owned, 0o700);
    }
    await f.cleanup();
  }
}
