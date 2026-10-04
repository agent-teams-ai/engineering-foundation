import assert from "node:assert/strict";
import { appendFile, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import {
  PACKAGE_QUALIFICATION_GROUPS,
  assertCompletePackageQualificationGroups, mapIndependentPackageTargets,
  parsePackageQualificationGroupArguments, runPackageQualificationPhases,
  COMBINED_PACKAGE_PROFILES, assertCompleteCombinedPackageProfiles,
  combinedPackageQualificationGroups, parseCombinedQualificationArguments,
} from "../scripts/package-qualification-groups.mts";
import { createPnpmRunner, runCommand } from "../scripts/pack-test-support.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });
const inventories = {
  packed: [
    "Docs integration", "packed consumer E2E", "SDK growth qualification", "authority scaffolding",
    "local-mode lifecycle", "agent-workflow fixture", "quality coverage", "quality gate runner",
  ],
  registry: [
    "npm-docs-only", "npm-docs-mcp", "pnpm-docs-only", "pnpm-docs-mcp", "npm-foundation",
  ],
} as const;
type FixtureBuildInput = Readonly<{ controlRoot: string; logPath: string; failureName?: string }>;
type FixtureBuildEvent = Readonly<{ kind: "start" | "end" | "failed"; name: string; cwd: string }>;

async function directory(t: TestContext, prefix: string) {
  const root = await mkdtemp(join(await realpath(tmpdir()), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await predicate()) { return; }
    await pause(10);
  }
  throw new Error(`Timed out waiting for TEST ${label}`);
}

// The mechanically generated TEST wrappers call this strictly checked runner.
export async function runFixturePackageBuild(input: FixtureBuildInput): Promise<void> {
  const manifest: unknown = JSON.parse(await readFile("package.json", "utf8"));
  assert.ok(manifest !== null && typeof manifest === "object" && "name" in manifest);
  assert.equal(typeof manifest.name, "string");
  const name = String(manifest.name);
  const cwd = process.cwd();
  const record = async (kind: FixtureBuildEvent["kind"]) => appendFile(input.logPath, `${JSON.stringify({ kind, name, cwd } satisfies FixtureBuildEvent)}\n`);
  await record("start");
  await waitFor(async () => {
    try { await readFile(join(input.controlRoot, name.split("/")[1])); return true; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") { return false; } throw error; }
  }, `release of ${name}`);
  if (input.failureName === name) {
    await record("failed");
    throw new Error("TEST bounded producer failure");
  }
  await mkdir("dist");
  await writeFile("dist/index.js", "export const value = 42;\n");
  await writeFile("dist/index.d.ts", "export declare const value: number;\n");
  await record("end");
}

async function buildEvents(logPath: string): Promise<FixtureBuildEvent[]> {
  let text: string;
  try { text = await readFile(logPath, "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") { return []; } throw error; }
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) { return []; }
  return text.slice(0, lastNewline).split("\n").filter(Boolean).map(line => {
    const event: unknown = JSON.parse(line);
    assert.ok(event !== null && typeof event === "object");
    assert.ok("kind" in event && (event.kind === "start" || event.kind === "end" || event.kind === "failed"));
    assert.ok("name" in event && typeof event.name === "string");
    assert.ok("cwd" in event && typeof event.cwd === "string");
    return event as FixtureBuildEvent;
  });
}

async function producerFixture(t: TestContext, failureName?: string) {
  const root = await directory(t, "qg-");
  const source = join(root, "source");
  const controlRoot = join(root, "control");
  const logPath = join(root, "builds.jsonl");
  await mkdir(controlRoot);
  await mkdir(source);
  await cp(join(repositoryRoot, "scripts"), join(source, "scripts"), { recursive: true });
  await mkdir(join(source, "packages"));
  await symlink(join(repositoryRoot, "packages", "engineering-foundation"), join(source, "packages", "engineering-foundation"),
    process.platform === "win32" ? "junction" : "dir");
  await symlink(join(repositoryRoot, "node_modules"), join(source, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  for (const name of ["LICENSE", ".node-version", "pnpm-lock.yaml", "package.json"]) {
    await copyFile(join(repositoryRoot, name), join(source, name));
  }
  await writeFile(join(source, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  const leaves = ["a", "b", "c"] as const;
  const catalog = leaves.map(leaf => ({ name: `@fixture/${leaf}`, root: `packages/${leaf}`,
    manifestPath: `packages/${leaf}/package.json`, changelogPath: `packages/${leaf}/CHANGELOG.md` }));
  const projectionPath = join(source, "scripts", "publishable-packages.mjs");
  const projection = await readFile(projectionPath, "utf8");
  const start = projection.indexOf("export const PUBLISHABLE_PACKAGE_CATALOG =");
  const end = projection.indexOf("\nfunction fail", start);
  assert.ok(start >= 0 && end > start);
  // Replace disposable TEST membership data; run the real projection and packer.
  await writeFile(projectionPath, `${projection.slice(0, start)}export const PUBLISHABLE_PACKAGE_CATALOG = Object.freeze(${JSON.stringify(catalog)});\n${projection.slice(end)}`);
  const buildInput: FixtureBuildInput = { controlRoot, logPath, ...(failureName === undefined ? {} : { failureName }) };
  for (const leaf of leaves) {
    const path = join(source, "packages", leaf);
    await mkdir(path);
    await writeFile(join(path, "README.md"), "# Disposable TEST package\n");
    await writeFile(join(path, "package.json"), JSON.stringify({
      name: `@fixture/${leaf}`, version: "1.2.3", type: "module",
      files: ["dist"], exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      scripts: { build: "node build.mts" },
    }));
    await writeFile(join(path, "build.mts"), `import { runFixturePackageBuild } from ${JSON.stringify(new URL("?fixture-build=1", import.meta.url).href)};\nawait runFixturePackageBuild(${JSON.stringify(buildInput)});\n`);
  }
  const api: typeof import("../scripts/pack-publishable-artifacts.mjs") = await import(pathToFileURL(join(source, "scripts", "pack-publishable-artifacts.mjs")).href);
  return { api, controlRoot, logPath, root };
}

if (new URL(import.meta.url).searchParams.get("fixture-build") !== "1") {
  // Omitting, repeating or mispairing a profile must lose observable consumer evidence.
  test("combined profiles retain every packed and registry phase exactly once", async () => {
    assert.deepEqual(COMBINED_PACKAGE_PROFILES, ["foundation", "npm-docs", "pnpm-docs"]);
    const completed = { packed: [] as string[], registry: [] as string[] };
    const expected = {
      foundation: { packed: "integration", registry: "foundation" },
      "npm-docs": { packed: "sdk-growth", registry: "npm-docs" },
      "pnpm-docs": { packed: "quality-coverage", registry: "pnpm-docs" },
    };
    assertCompleteCombinedPackageProfiles(COMBINED_PACKAGE_PROFILES);
    for (const profile of COMBINED_PACKAGE_PROFILES) {
      const groups = combinedPackageQualificationGroups(parseCombinedQualificationArguments([profile]));
      assert.deepEqual(groups, expected[profile]);
      for (const mode of ["packed", "registry"] as const) {
        await runPackageQualificationPhases(mode, groups[mode], inventories[mode].map(id => ({
          id, run: () => { completed[mode].push(id); },
        })));
      }
    }
    for (const mode of ["packed", "registry"] as const) {
      assert.deepEqual(completed[mode].toSorted(), inventories[mode].toSorted());
    }
    assert.equal(parseCombinedQualificationArguments([]), undefined);
    assert.deepEqual(combinedPackageQualificationGroups(), { packed: undefined, registry: undefined });
    for (const profiles of [[], ["foundation", "npm-docs"],
      ["foundation", "npm-docs", "npm-docs"], [...COMBINED_PACKAGE_PROFILES, "unknown"]]) {
      assert.throws(() => assertCompleteCombinedPackageProfiles(profiles), /complete closed profile set/u);
    }
    for (const args of [["unknown"], [""], ["foundation", "npm-docs"], ["--archive", "file.tgz"], [undefined]]) {
      assert.throws(() => parseCombinedQualificationArguments(args), /Package qualification groups/u);
    }
  });

  // Independent inventories and filesystem effects detect omitted/duplicated dispatch.
  test("closed group dispatch covers every original consumer exactly once", async t => {
    const scenarios = [
      { mode: "packed", inventory: inventories.packed, groups: [
        ["integration", ["Docs integration", "packed consumer E2E", "authority scaffolding", "local-mode lifecycle", "agent-workflow fixture", "quality gate runner"]],
        ["sdk-growth", ["SDK growth qualification"]], ["quality-coverage", ["quality coverage"]],
      ] },
      { mode: "registry", inventory: inventories.registry, groups: [
        ["npm-docs", ["npm-docs-only", "npm-docs-mcp"]], ["pnpm-docs", ["pnpm-docs-only", "pnpm-docs-mcp"]], ["foundation", ["npm-foundation"]],
      ] },
    ] as const;
    const root = await directory(t, "gd-");
    for (const scenario of scenarios) {
      const grouped: string[] = [];
      assertCompletePackageQualificationGroups(scenario.mode, scenario.groups.map(([group]) => group));
      for (const [group, expected] of [[undefined, scenario.inventory], ...scenario.groups] as const) {
        const path = join(root, `${scenario.mode}-${group ?? "complete"}`);
        await mkdir(path);
        const executed: string[] = [];
        await runPackageQualificationPhases(scenario.mode, group, scenario.inventory.map(id => ({
          id, run: async () => { await writeFile(join(path, Buffer.from(id).toString("hex")), id); executed.push(id); },
        })));
        assert.deepEqual(executed, expected);
        const markers = await Promise.all((await readdir(path)).map(name => readFile(join(path, name), "utf8")));
        assert.deepEqual(markers.toSorted(), expected.toSorted());
        if (group !== undefined) { grouped.push(...executed); }
      }
      assert.deepEqual(grouped.toSorted(), scenario.inventory.toSorted());
    }
  });

  test("missing, duplicate, unknown groups and incomplete dispatch reject before effects", async () => {
    for (const mode of ["packed", "registry"] as const) {
      const groups = PACKAGE_QUALIFICATION_GROUPS[mode];
      for (const bad of [[], [...groups, groups[0]], groups.slice(1), [...groups, "unknown"]]) {
        assert.throws(() => assertCompletePackageQualificationGroups(mode, bad), /Package qualification groups/u);
      }
      let effects = 0;
      const phases = inventories[mode].map(id => ({ id, run: () => { effects += 1; } }));
      for (const bad of [phases.slice(1), [...phases, phases[0]], phases.map((phase, index) => index === 0 ? { ...phase, id: "unknown" } : phase), phases.toReversed()]) {
        await assert.rejects(runPackageQualificationPhases(mode, undefined, bad), /complete ordered phase inventory/u);
      }
      assert.equal(effects, 0);
    }
    for (const args of [[], ["packed"], ["packed", "unknown"], ["registry", "integration"], ["packed", "integration", "integration"], ["combined", "integration"]]) {
      assert.throws(() => parsePackageQualificationGroupArguments(args), /Package qualification groups/u);
    }
    assert.deepEqual(parsePackageQualificationGroupArguments(["registry", "foundation"]), { mode: "registry", group: "foundation" });
  });

  test("independent filesystem preparation overlaps only within its bound", async t => {
    for (const concurrency of [1, 2]) {
      const root = await directory(t, "pb-");
      let active = 0; let peak = 0;
      const results = await mapIndependentPackageTargets([0, 1, 2, 3], async target => {
        active += 1; peak = Math.max(peak, active);
        assert.ok(active <= concurrency);
        const stage = join(root, String(target));
        await mkdir(stage);
        await writeFile(join(stage, "prepared"), String(target));
        active -= 1;
        return target;
      }, concurrency);
      assert.deepEqual(results, [0, 1, 2, 3]);
      assert.equal(peak, concurrency);
    }
    let effects = 0;
    for (const concurrency of [0, 3, 1.5, Number.NaN]) {
      await assert.rejects(mapIndependentPackageTargets([], () => { effects += 1; }, concurrency));
    }
    assert.equal(effects, 0);
  });

  test("real fresh production overlaps two targets, orders records and builds each target twice", async t => {
    const fixture = await producerFixture(t);
    let consumerCalls = 0;
    let invocationRoot: string | undefined;
    const production = fixture.api.withQualifiedPackageArtifacts("packed", async handle =>
      fixture.api.runQualifiedArtifactConsumer(handle, "packed", async ({ artifacts, temporaryRoot }) => {
        consumerCalls += 1;
        invocationRoot = temporaryRoot;
        assert.deepEqual(Object.keys(artifacts), ["@fixture/a", "@fixture/b", "@fixture/c"]);
      }));
    void production.catch(() => {});
    try {
      await waitFor(async () => (await buildEvents(fixture.logPath)).filter(event => event.kind === "start").length >= 2, "two overlapping real builds");
      assert.deepEqual((await buildEvents(fixture.logPath)).filter(event => event.kind === "start").map(event => event.name).toSorted(), ["@fixture/a", "@fixture/b"]);
      await writeFile(join(fixture.controlRoot, "b"), "release");
      await waitFor(async () => (await buildEvents(fixture.logPath)).some(event => event.name === "@fixture/c" && event.kind === "start"), "third target admission");
      await writeFile(join(fixture.controlRoot, "c"), "release");
      await waitFor(async () => (await buildEvents(fixture.logPath)).filter(event => event.name === "@fixture/c" && event.kind === "end").length === 2, "third target clean builds");
      assert.equal(consumerCalls, 0);
      await writeFile(join(fixture.controlRoot, "a"), "release");
      const evidence = await production;
      assert.deepEqual(evidence.map(record => record.name), ["@fixture/a", "@fixture/b", "@fixture/c"]);
      const events = await buildEvents(fixture.logPath);
      const starts = events.filter(event => event.kind === "start");
      assert.equal(starts.length, 6);
      assert.equal(new Set(starts.map(event => event.cwd)).size, 6);
      for (const leaf of ["a", "b", "c"]) {
        assert.deepEqual(events.filter(event => event.name === `@fixture/${leaf}`).map(event => event.kind), ["start", "end", "start", "end"]);
      }
      let active = 0; let peak = 0;
      for (const event of events) { active += event.kind === "start" ? 1 : -1; assert.ok(active >= 0 && active <= 2); peak = Math.max(peak, active); }
      assert.equal(peak, 2);
      assert.equal(consumerCalls, 1);
      assert.ok(invocationRoot);
      await assert.rejects(lstat(invocationRoot), { code: "ENOENT" });
    } finally {
      await Promise.all(["a", "b", "c"].map(leaf => writeFile(join(fixture.controlRoot, leaf), "release")));
      await production.catch(() => {});
    }
  });

  test("real producer failure drains an admitted sibling before invocation cleanup", async t => {
    const fixture = await producerFixture(t, "@fixture/a");
    let consumerCalls = 0;
    let settled = false;
    let invocationRoot: string | undefined;
    const production = fixture.api.withQualifiedPackageArtifacts("packed", () => { consumerCalls += 1; });
    void production.then(() => { settled = true; return true; }, () => { settled = true; return true; });
    try {
      await waitFor(async () => (await buildEvents(fixture.logPath)).filter(event => event.kind === "start").length >= 2, "two admitted producer targets");
      const starts = (await buildEvents(fixture.logPath)).filter(event => event.kind === "start");
      assert.deepEqual(starts.map(event => event.name).toSorted(), ["@fixture/a", "@fixture/b"]);
      const sibling = starts.find(event => event.name === "@fixture/b");
      assert.ok(sibling);
      invocationRoot = dirname(dirname(dirname(sibling.cwd)));
      await writeFile(join(fixture.controlRoot, "a"), "release");
      await waitFor(async () => (await buildEvents(fixture.logPath)).some(event => event.name === "@fixture/a" && event.kind === "failed"), "real target failure");
      assert.equal(settled, false);
      assert.equal((await lstat(invocationRoot)).isDirectory(), true);
      await writeFile(join(fixture.controlRoot, "b"), "release");
      await waitFor(async () => {
        const ends = (await buildEvents(fixture.logPath)).filter(event => event.name === "@fixture/b" && event.kind === "end").length;
        if (ends === 2) { return true; }
        assert.equal(settled, false, "producer closed before the admitted sibling finished its clean builds");
        return false;
      }, "admitted sibling clean builds");
      await assert.rejects(production, error => {
        assert.ok(error instanceof Error && "stderr" in error && typeof error.stderr === "string");
        assert.match(error.stderr, /TEST bounded producer failure/u);
        return true;
      });
      const events = await buildEvents(fixture.logPath);
      assert.equal(events.filter(event => event.name === "@fixture/b" && event.kind === "start").length, 2);
      assert.equal(events.some(event => event.name === "@fixture/c"), false);
      assert.equal(consumerCalls, 0);
      await assert.rejects(lstat(invocationRoot), { code: "ENOENT" });
    } finally {
      await Promise.all(["a", "b", "c"].map(leaf => writeFile(join(fixture.controlRoot, leaf), "release")));
      await production.catch(() => {});
    }
  });

  test("first and undefined preparation failures drain started work before cleanup", async t => {
    for (const reason of [new Error("first preparation failure"), undefined]) {
      const root = await directory(t, "pd-");
      const secondStarted = Promise.withResolvers<void>();
      const firstFailed = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const started: number[] = [];
      let cleanup = false;
      let joined = "";
      const owner = (async () => {
        try {
          return await mapIndependentPackageTargets([0, 1, 2], async target => {
            started.push(target);
            await mkdir(join(root, String(target)));
            if (target === 0) { await secondStarted.promise; firstFailed.resolve(); throw reason; }
            if (target === 1) {
              secondStarted.resolve(); await release.promise;
              await writeFile(join(root, "settled"), "settled");
              throw new Error("late sibling failure");
            }
            return target;
          });
        } finally {
          cleanup = true;
          joined = await readFile(join(root, "settled"), "utf8");
          await rm(root, { recursive: true, force: false });
        }
      })();
      void owner.catch(() => {});
      try {
        await firstFailed.promise;
        await pause(0);
        assert.equal(cleanup, false);
        assert.deepEqual(started, [0, 1]);
        assert.equal((await lstat(root)).isDirectory(), true);
        release.resolve();
        await assert.rejects(owner, error => error === reason);
        assert.equal(joined, "settled");
      } finally {
        release.resolve();
        await owner.catch(() => {});
      }
    }
  });

  test("actual pnpm group wrapper rejects invalid arguments before allocating", async t => {
    const root = await directory(t, "ga-");
    const sentinel = join(repositoryRoot, "packages/engineering-foundation/dist/group-refusal-TEST.js");
    await writeFile(sentinel, "TEST stale distribution sentinel\n", { flag: "wx" });
    t.after(() => rm(sentinel, { force: true }));
    const runPnpm = createPnpmRunner();
    for (const args of [[], ["packed"], ["packed", "unknown"], ["packed", "integration", "integration"],
      ["registry", "npm-docs", "--archive", "/tmp/forged.tgz"]]) {
      await assert.rejects(runPnpm(["package:group:built", ...args], repositoryRoot, {
        environment: { ...process.env, TMPDIR: root, TMP: root, TEMP: root, NODE_DISABLE_COMPILE_CACHE: "1" },
      }), error => {
        assert.ok(error instanceof Error && "stderr" in error && typeof error.stderr === "string");
        assert.match(error.stderr, /Package qualification groups/u);
        return true;
      });
      assert.deepEqual(await readdir(root), []);
      assert.equal(await readFile(sentinel, "utf8"), "TEST stale distribution sentinel\n");
    }
  });
}
