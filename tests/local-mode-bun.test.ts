import assert from "node:assert/strict";
import { link as hardlink, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { inspectConsumerManifest } from "../packages/engineering-foundation/dist/local-mode/application/consumer-policy.js";
import { inspectBunLockfile } from "../packages/engineering-foundation/dist/local-mode/application/bun-registry-policy.js";
import { FoundationLocalModeService, inspectFoundationDevOnly, inspectFoundationRegistryProvenance } from "../packages/engineering-foundation/dist/local-mode/index.js";
import { LocalPackageLifecycle } from "../packages/engineering-foundation/dist/local-mode/application/service.js";
import { createNodeLocalPackageLifecyclePorts } from "../packages/engineering-foundation/dist/local-mode/composition/service.js";

const name = "@agent-teams/engineering-foundation";
const version = "2.0.1";
const integrity = `sha512-${"A".repeat(86)}==`;
const manifest = (packageManager = "bun@1.4.3") => ({ packageManager, devDependencies: { [name]: version } });
const lock = () => ({ lockfileVersion: 2, configVersion: 1,
  workspaces: { "": { devDependencies: { [name]: version } } },
  packages: { [name]: [`${name}@${version}`, "", {}, integrity] } });

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foundation-bun-registry-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = join(root, "node_modules/.bun", `@agent-teams+engineering-foundation@${version}+edf16661289b0c7a`, "node_modules", name);
  await mkdir(installed, { recursive: true });
  await mkdir(join(root, "node_modules/@agent-teams"), { recursive: true });
  await symlink(installed, join(root, "node_modules", name), process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(installed, "package.json"), JSON.stringify({ name, version }));
  await writeFile(join(root, "package.json"), JSON.stringify(manifest()));
  await writeFile(join(root, "bun.lock"), JSON.stringify(lock()));
  return { root, installed };
}

test("Bun registry admission retains exact stable manager and development-only policy", () => {
  assert.deepEqual(inspectConsumerManifest("/consumer", manifest()).issues, []);
  assert.deepEqual(inspectConsumerManifest("/consumer", manifest("pnpm@11.20.0")).issues, []);
  for (const pin of ["bun@1", "bun@^1.4.3", "bun@1.4.3-canary.1", "bun@1.4.3+build", "bun@2.0.0", "bun@01.4.3", "bun@1.04.3"]) {
    assert.ok(inspectConsumerManifest("/consumer", manifest(pin)).issues.length > 0, pin);
  }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions", "patchedDependencies"]) {
    assert.ok(inspectConsumerManifest("/consumer", { ...manifest(), [field]: { [name]: version } }).issues.length > 0, field);
  }
  for (const field of ["overrides", "patchedDependencies"]) {
    assert.ok(inspectConsumerManifest("/consumer", { ...manifest(), pnpm: { [field]: { [name]: version } } }).issues.length > 0, field);
  }
  assert.ok(inspectConsumerManifest("/consumer", { ...manifest(), bundledDependencies: [name] }).issues.length > 0);
});

const rejects = (candidate: Record<string, unknown>, spec: string | undefined = version) =>
  assert.ok(inspectBunLockfile(candidate, spec).issues.length > 0, JSON.stringify(candidate));

test("Bun registry policy rejects ambiguous or non-registry lock selections", () => {
  assert.deepEqual(inspectBunLockfile(lock(), version).issues, []);
  assert.equal(inspectBunLockfile(lock(), version).packageKey, name);
  assert.ok(inspectBunLockfile(lock()).issues.length > 0);
  rejects(lock(), "^2.0.1");
  rejects({ ...lock(), lockfileVersion: 1 });
  rejects({ ...lock(), configVersion: 2 });
  rejects({ ...lock(), workspaces: {} });
  rejects({ ...lock(), workspaces: { "": { devDependencies: { [name]: "2.0.0" } } } });
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    rejects({ ...lock(), workspaces: { "": { ...lock().workspaces[""], [field]: { [name]: version } } } });
  }
  for (const field of ["overrides", "resolutions", "patchedDependencies"]) {rejects({ ...lock(), [field]: { [name]: version } });}
  for (const tuple of [[], [`${name}@2.0.0`, "", {}, integrity], [`${name}@${version}`, "https://other.example", {}, integrity],
    [`${name}@${version}`, "", null, integrity], [`${name}@${version}`, "", {}, "sha512-AA=="],
    [`${name}@${version}`, "", {}, `sha512-${"A".repeat(85)}B==`], [`${name}@${version}`, "", {}, integrity, {}],
    ["file:../foundation", "", {}, integrity], ["git+https://example.test/repo", "", {}, integrity]]) {
    rejects({ ...lock(), packages: { [name]: tuple } });
  }
  rejects({ ...lock(), packages: { ...lock().packages, alias: lock().packages[name] } });
});

test("Bun registry inspection binds unique bounded lock and installed isolated identity without pnpm fallback", async (t) => {
  const { root, installed } = await fixture(t);
  const inspect = () => inspectFoundationRegistryProvenance(root, version);
  assert.deepEqual((await inspect()).issues, []);
  assert.equal((await inspect()).provenance?.integrity, integrity);
  assert.equal((await inspect()).provenance?.packageKey, name);
  assert.deepEqual((await inspectFoundationRegistryProvenance(relative(process.cwd(), root), version)).issues, []);
  const consumerAlias = join(root, "consumer-alias");
  await symlink(root, consumerAlias, process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual((await inspectFoundationRegistryProvenance(consumerAlias, version)).issues, []);
  await rm(consumerAlias);
  for (const path of [join(root, "bun.lock"), join(root, "package.json"), join(installed, "package.json")]) {
    const alias = `${path}.hardlink`;
    await hardlink(path, alias);
    try {
      assert.deepEqual((await inspect()).issues, [], "stable hardlinked evidence remains admitted");
    } finally {
      await rm(alias);
    }
    assert.deepEqual((await inspect()).issues, [], "single-link evidence remains admitted");
  }
  const lockAlias = join(root, "aliased-bun.lock");
  await writeFile(lockAlias, JSON.stringify(lock()));
  await rm(join(root, "bun.lock"));
  await symlink(lockAlias, join(root, "bun.lock"));
  assert.ok((await inspect()).issues.length > 0, "symlink lock must reject even with valid bytes");
  await rm(join(root, "bun.lock"));
  await writeFile(join(root, "bun.lock"), JSON.stringify(lock()));
  for (const source of ["{}", "{", `${JSON.stringify(lock()).slice(0, -1)},"packages":{}}`,
    JSON.stringify(lock()).replace('"configVersion":1', '"configVersion":1,"configVersion":1'),
    " ".repeat(4 * 1024 * 1024 + 1)]) {
    await writeFile(join(root, "bun.lock"), source);
    assert.ok((await inspect()).issues.length > 0);
  }
  const rollbackLock = `lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      ${name}:\n        specifier: ${version}\n        version: ${version}\npackages:\n  ${name}@${version}:\n    resolution:\n      integrity: ${integrity}\nsnapshots:\n  ${name}@${version}: {}\n`;
  await writeFile(join(root, "pnpm-lock.yaml"), rollbackLock);
  await mkdir(join(root, "node_modules/.pnpm"));
  await writeFile(join(root, "node_modules/.pnpm/lock.yaml"), rollbackLock);
  await rm(join(root, "bun.lock"));
  assert.ok((await inspect()).issues.length > 0);
  await writeFile(join(root, "bun.lock"), `// Bun text lock\n${JSON.stringify(lock()).slice(0, -1)},}`);
  assert.deepEqual((await inspect()).issues, []);
  const atLimit = JSON.stringify(lock()).padEnd(4 * 1024 * 1024, " ");
  await writeFile(join(root, "bun.lock"), atLimit);
  assert.deepEqual((await inspect()).issues, []);
  await writeFile(join(root, "bun.lock"), `${atLimit} `);
  assert.ok((await inspect()).issues.length > 0);
  await writeFile(join(root, "bun.lock"), JSON.stringify(lock()));
  for (const source of ["{", JSON.stringify(manifest("bun@2.0.0")), JSON.stringify(manifest("bun@^1.4.3")),
    `{"packageManager":"bun@1.4.3","packageManager":"pnpm@11.20.0","devDependencies":{"${name}":"${version}"}}`]) {
    await writeFile(join(root, "package.json"), source);
    assert.ok((await inspect()).issues.length > 0, "invalid active manifest must never select retained pnpm evidence");
  }
  await writeFile(join(root, "package.json"), JSON.stringify(manifest()));
  for (const candidate of [{ name: "other", version }, { name, version: "2.0.0" }]) {
    await writeFile(join(installed, "package.json"), JSON.stringify(candidate));
    assert.ok((await inspect()).issues.length > 0);
  }
  await writeFile(join(installed, "package.json"), `{"name":"${name}","version":"${version}","version":"${version}"}`);
  assert.ok((await inspect()).issues.length > 0);
  await writeFile(join(root, "package.json"), `{"packageManager":"bun@1.4.3","devDependencies":{"${name}":"${version}","${name}":"${version}"}}`);
  assert.ok((await inspectFoundationDevOnly(root)).issues.length > 0);
  assert.ok((await inspect()).issues.length > 0);
});

test("Bun registry inspection rejects hoisted external and symlinked manifest selections", async (t) => {
  const { root, installed } = await fixture(t);
  const link = join(root, "node_modules", name);
  const inspect = () => inspectFoundationRegistryProvenance(root, version);
  const alternate = join(root, "outside-store");
  await mkdir(alternate);
  await writeFile(join(alternate, "package.json"), JSON.stringify({ name, version }));
  await rm(link, { recursive: true });
  await symlink(alternate, link, process.platform === "win32" ? "junction" : "dir");
  assert.ok((await inspect()).issues.length > 0);
  await rm(link, { recursive: true });
  await mkdir(link);
  await writeFile(join(link, "package.json"), JSON.stringify({ name, version }));
  assert.ok((await inspect()).issues.length > 0);
  await rm(link, { recursive: true });
  await symlink(installed, link, process.platform === "win32" ? "junction" : "dir");
  await rm(join(installed, "package.json"));
  await symlink(join(alternate, "package.json"), join(installed, "package.json"));
  assert.ok((await inspect()).issues.length > 0);
  await rm(join(installed, "package.json"));
  await mkdir(join(installed, "package.json"));
  assert.ok((await inspect()).issues.length > 0);
});

test("Bun concrete lifecycle refuses attach detach and reattach before lease process or writes", async (t) => {
  const { root } = await fixture(t);
  let processes = 0;
  const service = new FoundationLocalModeService({ now: () => new Date(), runner: { run: async () => { processes++; throw new Error("Unexpected process"); } } });
  assert.deepEqual((await service.assertDevOnly(root)).issues, []);
  const registry = await service.assertRegistry(root);
  assert.equal(registry.mode, "REGISTRY");
  assert.equal(registry.lockfilePackageKey, name);
  const before = await readFile(join(root, "bun.lock"), "utf8");
  for (const invoke of [() => service.attach(root, "/missing-target"), () => service.detach(root), () => service.attach(root, root)]) {
    await assert.rejects(invoke, /registry inspection only/u);
  }
  assert.equal(processes, 0);
  assert.equal(await readFile(join(root, "bun.lock"), "utf8"), before);
  await assert.rejects(readdir(join(root, ".agent-teams-local")), { code: "ENOENT" });
});

function guardedPorts(root: string, effects: string[], flipAfterLease: boolean) {
  return createNodeLocalPackageLifecyclePorts({
    runner: { run: async () => { effects.push("process"); throw new Error("Unexpected process"); } },
    mode: async () => {
      effects.push("mode");
      if (flipAfterLease) {
        await writeFile(join(root, "package.json"), JSON.stringify(manifest()));
      }
      return { mode: "REGISTRY", consumerRoot: root, dependencySpec: version, installedPackageRoot: join(root, "node_modules", name), issues: [] };
    },
    inspectPackage: async () => { effects.push("target"); throw new Error("Unexpected target"); },
    stateDirectory: { ensure: async () => { effects.push("write"); }, sync: async () => { effects.push("write"); }, prune: async () => { effects.push("write"); } },
    coordinator: async () => {
      effects.push("coordinator");
      return { acquire: async () => { effects.push("lease"); return { status: { state: "idle", diagnostics: [] }, release: async () => { effects.push("release"); } }; },
        inspect: async () => ({ state: "idle", diagnostics: [] }) };
    }
  });
}

test("Bun concrete ports reject initial and post-lease manager changes while releasing the lease", async (t) => {
  const { root } = await fixture(t);
  for (const method of ["attach", "detach"] as const) {
    const effects: string[] = [];
    const lifecycle = new LocalPackageLifecycle({ now: () => new Date(), ports: guardedPorts(root, effects, false) });
    await assert.rejects(method === "attach" ? lifecycle.attach(root, root) : lifecycle.detach(root), /registry inspection only/u);
    assert.ok(!effects.includes("lease") && !effects.includes("process") && !effects.includes("write"));
  }
  for (const method of ["attach", "detach"] as const) {
    await writeFile(join(root, "package.json"), JSON.stringify(manifest("pnpm@11.20.0")));
    const effects: string[] = [];
    const ports = guardedPorts(root, effects, true);
    if (method === "detach") {
      const initialMode = ports.inspection.mode;
      let calls = 0;
      ports.inspection.mode = async (path, options) => {
        if (++calls === 1) {return { mode: "REGISTRY", consumerRoot: root, dependencySpec: version, issues: [] };}
        return initialMode(path, options);
      };
    }
    const lifecycle = new LocalPackageLifecycle({ now: () => new Date(), ports });
    await assert.rejects(method === "attach" ? lifecycle.attach(root, root) : lifecycle.detach(root), /registry inspection only/u);
    assert.ok(effects.includes("lease") && effects.includes("release"));
    assert.ok(!effects.includes("process") && !effects.includes("target") && !effects.includes("write"));
  }
});
