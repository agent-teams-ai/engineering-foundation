import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import { qualifyPackedQualityAssets } from "../scripts/pack-quality-assets.ts";

import {
  copyInstalledClosure,
  invokeInstalledTypecheck,
  qualifyExternalDeclaration,
} from "../scripts/pack-quality-coverage-test.mjs";
import {
  qualifyMissingDeclaration,
  assertMissingTypeDiagnostic,
} from "../scripts/packed-quality-lint-protections.ts";
import { writeQualityLayout } from "../scripts/packed-quality-layout.ts";
import { runCommand } from "../scripts/pack-test-support.mjs";
import { copyPinnedToolchain } from "./features/quality-coverage/copied-toolchain.mjs";

async function createQualityClosureFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "quality-closure-fixture-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const consumerRoot = join(root, "source-consumer");
  const source = join(consumerRoot, "node_modules");
  const destination = join(root, "copied-consumer", "node_modules");
  const fixtureRoot = join(consumerRoot, "packages", "library");
  const fixtureLink = join(source, ".pnpm", "node_modules", "@fixture", "public-api");
  const installedTool = join(source, ".pnpm", "tool@1.0.0", "node_modules", "tool");
  await mkdir(fixtureRoot, { recursive: true });
  await mkdir(join(fixtureLink, ".."), { recursive: true });
  await mkdir(installedTool, { recursive: true });
  await mkdir(join(destination, ".."), { recursive: true });
  await writeFile(
    join(fixtureRoot, "package.json"),
    JSON.stringify({ name: "@fixture/public-api" }),
  );
  await writeFile(join(fixtureRoot, "fixture.txt"), "workspace fixture bytes\n");
  await writeFile(
    join(installedTool, "package.json"),
    JSON.stringify({ name: "tool", version: "1.0.0" }),
  );
  const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(
    process.platform === "win32" ? fixtureRoot : "../../../../packages/library",
    fixtureLink,
    directoryLinkType,
  );
  await symlink(installedTool, join(source, "tool"), directoryLinkType);
  return { consumerRoot, destination, fixtureRoot, root, source };
}

test("quality closure materializes only its real workspace fixture", async (t) => {
  const fixture = await createQualityClosureFixture(t);
  await copyInstalledClosure(fixture.source, fixture.destination);

  const copiedFixture = join(
    fixture.destination,
    ".pnpm",
    "node_modules",
    "@fixture",
    "public-api",
  );
  assert((await lstat(copiedFixture)).isDirectory());
  assert(!(await lstat(copiedFixture)).isSymbolicLink());
  await rm(fixture.consumerRoot, { force: true, recursive: true });
  assert.equal(
    await readFile(join(copiedFixture, "fixture.txt"), "utf8"),
    "workspace fixture bytes\n",
  );
  assert.equal(
    await readFile(join(fixture.destination, "tool", "package.json"), "utf8"),
    JSON.stringify({ name: "tool", version: "1.0.0" }),
  );
  const copiedTool = await realpath(join(fixture.destination, "tool"));
  assert.equal(
    relative(await realpath(fixture.destination), copiedTool).split(/[\\/]/u)[0],
    ".pnpm",
  );
});

test("quality closure rejects arbitrary absolute and sibling links", async (t) => {
  for (const name of ["absolute", "sibling"]) {
    await t.test(name, async (context) => {
      const root = await mkdtemp(join(tmpdir(), `quality-closure-${name}-`));
      context.after(() => rm(root, { force: true, recursive: true }));
      const source = join(root, "consumer", "node_modules");
      const outside = join(root, name === "absolute" ? "outside" : "consumer", "sibling");
      const destination = join(root, "copied", "node_modules");
      await mkdir(source, { recursive: true });
      await mkdir(outside, { recursive: true });
      await mkdir(join(destination, ".."), { recursive: true });
      await symlink(
        name === "absolute" || process.platform === "win32" ? outside : "../sibling",
        join(source, "malicious"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await assert.rejects(
        copyInstalledClosure(source, destination),
        /Installed dependency link escapes its node_modules closure/u,
      );
      await assert.rejects(lstat(destination), { code: "ENOENT" });
    });
  }
});

test("quality closure rejects an approved-path link to an arbitrary target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "quality-closure-spoofed-fixture-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const source = join(root, "consumer", "node_modules");
  const destination = join(root, "copied", "node_modules");
  const fixtureLink = join(source, ".pnpm", "node_modules", "@fixture", "public-api");
  const outside = join(root, "outside");
  await mkdir(join(fixtureLink, ".."), { recursive: true });
  await mkdir(join(destination, ".."), { recursive: true });
  await mkdir(outside);
  await symlink(outside, fixtureLink, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    copyInstalledClosure(source, destination),
    /Installed dependency link escapes its node_modules closure/u,
  );
  await assert.rejects(lstat(destination), { code: "ENOENT" });
});

test("quality closure rejects links hidden in the approved fixture", async (t) => {
  const fixture = await createQualityClosureFixture(t);
  const outside = join(fixture.root, "outside");
  await mkdir(outside);
  await symlink(
    outside,
    join(fixture.fixtureRoot, "hidden-dependency"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    copyInstalledClosure(fixture.source, fixture.destination),
    /Approved workspace fixture target must not contain symbolic links/u,
  );
  await assert.rejects(lstat(fixture.destination), { code: "ENOENT" });
});

test("quality closure validates the fixture snapshot after copying it", async (t) => {
  const fixture = await createQualityClosureFixture(t);
  const outside = join(fixture.root, "outside");
  await mkdir(outside);
  await assert.rejects(
    copyInstalledClosure(fixture.source, fixture.destination, {
      afterFixtureTargetApproved: async () => {
        await symlink(
          outside,
          join(fixture.fixtureRoot, "late-hidden-dependency"),
          process.platform === "win32" ? "junction" : "dir",
        );
      },
    }),
    /Approved workspace fixture target must not contain symbolic links/u,
  );
  await assert.rejects(lstat(fixture.destination), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(fixture.destination, "..")), []);
});

test("quality closure rejects an installed link added after its link plan", async (t) => {
  const fixture = await createQualityClosureFixture(t);
  const outside = join(fixture.root, "outside");
  await mkdir(outside);
  await assert.rejects(
    copyInstalledClosure(fixture.source, fixture.destination, {
      afterFixtureTargetApproved: async () => {
        await symlink(
          outside,
          join(fixture.source, "late-link"),
          process.platform === "win32" ? "junction" : "dir",
        );
      },
    }),
    /Installed dependency link set changed during copy/u,
  );
  await assert.rejects(lstat(fixture.destination), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(fixture.destination, "..")), []);
});

test("quality closure rejects a planned link replaced by a directory after planning", async (t) => {
  const fixture = await createQualityClosureFixture(t);
  await assert.rejects(
    copyInstalledClosure(fixture.source, fixture.destination, {
      afterFixtureTargetApproved: async () => {
        await rm(join(fixture.source, "tool"), { force: true, recursive: true });
        await mkdir(join(fixture.source, "tool"));
        await writeFile(join(fixture.source, "tool", "package.json"), "{}");
      },
    }),
    /Installed dependency link set changed during copy/u,
  );
  await assert.rejects(lstat(fixture.destination), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(fixture.destination, "..")), []);
});

test("quality closure rejects a manifest symlink replacement after snapshot validation", async (t) => {
  const fixture = await createQualityClosureFixture(t);
  const outsideManifest = join(fixture.root, "outside-package.json");
  const symlinkProbe = join(fixture.root, "manifest-symlink-probe.json");
  await writeFile(outsideManifest, JSON.stringify({ name: "@fixture/public-api" }));
  try {
    await symlink(outsideManifest, symlinkProbe, "file");
  } catch (error) {
    if (process.platform === "win32" && error?.code === "EPERM") {
      t.skip("Creating file symlinks requires unavailable Windows privileges");
      return;
    }
    throw error;
  }
  await rm(symlinkProbe);
  await assert.rejects(
    copyInstalledClosure(fixture.source, fixture.destination, {
      afterFixtureSnapshotTreeValidated: async ({ snapshot }) => {
        const manifestPath = join(snapshot, "package.json");
        await rm(manifestPath);
        await symlink(outsideManifest, manifestPath);
      },
    }),
    (error) =>
      error?.code === "ELOOP" ||
      (error?.code === "ERR_ASSERTION" &&
        /Approved workspace fixture manifest must be a regular file/u.test(error.message)),
  );
  await assert.rejects(lstat(fixture.destination), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(fixture.destination, "..")), []);
});

test("quality closure rejects a manifest path replacement after opening it", async (t) => {
  const fixture = await createQualityClosureFixture(t);
  const { ino } = await lstat(join(fixture.fixtureRoot, "package.json"), { bigint: true });
  if (ino === 0n) {
    t.skip("File IDs are unavailable on this filesystem");
    return;
  }
  await assert.rejects(
    copyInstalledClosure(fixture.source, fixture.destination, {
      afterFixtureSnapshotManifestOpened: async ({ manifestPath }) => {
        await rm(manifestPath);
        await writeFile(manifestPath, JSON.stringify({ name: "@fixture/public-api" }));
      },
    }),
    /Approved workspace fixture manifest identity changed/u,
  );
  await assert.rejects(lstat(fixture.destination), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(fixture.destination, "..")), []);
});

test("quality closure never rereads the fixture after validating its snapshot", async (t) => {
  await t.test("source mutation", async (context) => {
    const fixture = await createQualityClosureFixture(context);
    const outside = join(fixture.root, "replacement");
    await mkdir(outside);
    await writeFile(join(outside, "fixture.txt"), "replacement bytes\n");
    await copyInstalledClosure(fixture.source, fixture.destination, {
      afterFixtureSnapshotValidated: async () => {
        await rm(fixture.fixtureRoot, { force: true, recursive: true });
        await symlink(
          outside,
          fixture.fixtureRoot,
          process.platform === "win32" ? "junction" : "dir",
        );
      },
    });
    assert.equal(
      await readFile(
        join(fixture.destination, ".pnpm", "node_modules", "@fixture", "public-api", "fixture.txt"),
        "utf8",
      ),
      "workspace fixture bytes\n",
    );
  });

  await t.test("source deletion", async (context) => {
    const fixture = await createQualityClosureFixture(context);
    await copyInstalledClosure(fixture.source, fixture.destination, {
      afterFixtureSnapshotValidated: async () => {
        await rm(fixture.fixtureRoot, { force: true, recursive: true });
      },
    });
    assert.equal(
      await readFile(
        join(fixture.destination, ".pnpm", "node_modules", "@fixture", "public-api", "fixture.txt"),
        "utf8",
      ),
      "workspace fixture bytes\n",
    );
  });
});

test("packed asset extension preserves and validates the consumer profile schema", async (t) => {
  for (const schemaVersion of [3, 4]) {
    await t.test(`v${schemaVersion}`, async (context) => {
      const root = await mkdtemp(join(tmpdir(), "quality-assets-schema-"));
      context.after(() => rm(root, { recursive: true, force: true }));
      const profile = {
        schemaVersion,
        sourcePolicyPath: "source.yaml",
        suppressionPolicyPath: "suppressions.yaml",
        featureProfilePath: "features.json",
        lintConfigPath: "lint.json",
        ...(schemaVersion === 4
          ? { toolchainConfigPath: "toolchain.config.json" }
          : { compilerProjects: ["tsconfig.json"] }),
        scripts: { fast: "check:fast", full: "check", scope: "quality:scope", typed: "lint:typed" },
      };
      const put = async (path, value) => {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(
          join(root, path),
          typeof value === "string" ? value : JSON.stringify(value),
        );
      };
      await put("quality.yaml", profile);
      await put("package.json", { scripts: { check: "pnpm lint:typed" } });
      const original = await readFile(join(root, "quality.yaml"), "utf8");
      const schema = JSON.parse(
        await readFile(
          new URL(
            `../packages/engineering-foundation/schemas/quality-source-coverage/v${schemaVersion}.schema.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const validate = new Ajv2020({ strict: true }).compile(schema);
      let calls = 0;
      await qualifyPackedQualityAssets({
        root,
        sourceRoot: "packages/worker/src",
        boundaryId: "worker",
        put,
        invoke: async (_args, code = 0) => {
          calls += 1;
          const extended = JSON.parse(await readFile(join(root, "quality.yaml"), "utf8"));
          assert.equal(extended.schemaVersion, schemaVersion);
          assert.ok(validate(extended), JSON.stringify(validate.errors));
          if (code === 0) {
            return { outcome: "passed", capabilities: [] };
          }
          const hidden = calls === 5;
          return {
            outcome: "violations",
            capabilities: [
              {
                diagnostics: [
                  {
                    ruleId: `quality.source-coverage.${hidden ? "source-language" : "asset-route"}`,
                    location: {
                      path: `packages/worker/src/adapters/migrations/${hidden ? "undeclared.sql" : "0001-asset.sql"}`,
                    },
                  },
                ],
              },
            ],
          };
        },
      });
      assert.equal(calls, 5);
      assert.equal(await readFile(join(root, "quality.yaml"), "utf8"), original);
    });
  }
});

test("missing declarations belong to installed Toolchain typecheck and restore fixture bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "quality-typecheck-split-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, value) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  const devDependencies = await copyPinnedToolchain(root);
  const { main, sourceRoot } = await writeQualityLayout({ nested: true, devDependencies, put });
  const mainBytes = await readFile(join(root, main), "utf8");
  const declarationBytes = await readFile(join(root, sourceRoot, "owned.d.ts"), "utf8");
  const compilerBytes = await readFile(join(root, "config/production.json"), "utf8");
  const observed = [];
  const invokeTypecheck = async () => {
    const result = await invokeInstalledTypecheck(root);
    observed.push(result);
    return result;
  };
  const inventory = [];
  const invoke = async (_args, code = 0) => {
    try {
      const result = await runCommand(
        process.execPath,
        [
          join(root, "node_modules/typescript/bin/tsc"),
          "--project",
          "config/production.json",
          "--listFilesOnly",
          "--pretty",
          "false",
        ],
        root,
      );
      inventory.push({ exitCode: 0, stdout: result.stdout });
    } catch (error) {
      assert.equal(code, 3, "only missing configured types prevents inventory loading");
      assert.equal(error.code, 1);
      assert.match(error.stdout, /TS2688[^\n]*quality-fixture/u);
      inventory.push({ exitCode: error.code, stdout: error.stdout });
      return { outcome: "failed", capabilities: [{ diagnostics: [] }] };
    }
    assert.equal(code, 0);
    return { outcome: "passed", capabilities: [{ diagnostics: [] }] };
  };
  await qualifyMissingDeclaration({ root, put, invoke, invokeTypecheck, sourceRoot, main });
  await qualifyExternalDeclaration({
    root,
    put,
    invoke,
    invokeTypecheck,
    main,
    compilerConfig: JSON.parse(compilerBytes),
  });
  assert.deepEqual(
    inventory.map(({ exitCode }) => exitCode),
    [0, 0, 0, 0, 1, 0],
  );
  assert.doesNotMatch(inventory[1].stdout, /TS2307/u);
  assert.match(inventory[4].stdout, /TS2688[^\n]*quality-fixture/u);
  assert.deepEqual(
    observed.map(({ exitCode }) => exitCode),
    [0, 1, 0, 0, 1, 0],
  );
  assert.match(observed[1].stdout, /TS2307[^\n]*owned\.js/u);
  assert.match(observed[4].stdout, /TS2688[^\n]*quality-fixture/u);
  assert.equal(await readFile(join(root, main), "utf8"), mainBytes);
  assert.equal(await readFile(join(root, sourceRoot, "owned.d.ts"), "utf8"), declarationBytes);
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "config/production.json"), "utf8")),
    JSON.parse(compilerBytes),
  );
  assert.throws(() =>
    assertMissingTypeDiagnostic(
      { exitCode: 2, stdout: '"code":"TOOLCHAIN_ALL_ENGINES_FAILED"', stderr: "" },
      /TS2307/u,
    ),
  );
  const fixtureFailure = new Error("injected typecheck interruption");
  let interruptionCalls = 0;
  await assert.rejects(
    qualifyMissingDeclaration({
      root,
      put,
      invoke,
      sourceRoot,
      main,
      invokeTypecheck: async () => {
        interruptionCalls += 1;
        if (interruptionCalls === 2) {
          throw fixtureFailure;
        }
        return invokeInstalledTypecheck(root);
      },
    }),
    fixtureFailure,
  );
  assert.equal(interruptionCalls, 2);
  assert.equal(await readFile(join(root, main), "utf8"), mainBytes);
  assert.equal(await readFile(join(root, sourceRoot, "owned.d.ts"), "utf8"), declarationBytes);
  assert.throws(() =>
    assertMissingTypeDiagnostic(
      {
        exitCode: 1,
        stdout: '"code":"TOOLCHAIN_DIAGNOSTICS", TS2322 unrelated',
        stderr: "",
      },
      /TS2307[^\n]*owned\.js/u,
    ),
  );
  interruptionCalls = 0;
  await assert.rejects(
    qualifyExternalDeclaration({
      root,
      put,
      invoke,
      main,
      compilerConfig: JSON.parse(compilerBytes),
      invokeTypecheck: async () => {
        interruptionCalls += 1;
        if (interruptionCalls === 2) {
          throw fixtureFailure;
        }
        return invokeInstalledTypecheck(root);
      },
    }),
    fixtureFailure,
  );
  assert.equal(interruptionCalls, 2);
  assert.equal(await readFile(join(root, main), "utf8"), mainBytes);
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "config/production.json"), "utf8")),
    JSON.parse(compilerBytes),
  );
  await assert.rejects(lstat(join(root, "node_modules/@types/quality-fixture")), {
    code: "ENOENT",
  });
});
