import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { verifyPackedScaffoldingQualification } from "../../scripts/pack-scaffolding-qualification-test.mjs";
import { resolveQualificationExecutables } from "../../tools/executable-policy.mts";
import { TOOL_COMMANDS } from "../../tools/repository-tool-catalog.ts";
import { admitRepositoryTypeScript } from "../../tools/typescript-admission.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const nativeName = `@typescript/typescript-${process.platform}-${process.arch}`;
const compilerVersion = "7.0.2";

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function compilerFixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "repository-compiler-admission-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const wrapper = join(root, "node_modules/typescript");
  const native = join(root, "node_modules", nativeName);
  const marker = join(root, "candidate-executed");
  const wrapperMetadata = {
    name: "typescript",
    version: compilerVersion,
    type: "module",
    bin: { tsc: "./bin/tsc" },
    imports: { "#getExePath": "./lib/getExePath.js" },
    optionalDependencies: { [nativeName]: compilerVersion },
  };
  const nativeMetadata = {
    name: nativeName,
    version: compilerVersion,
    exports: { "./package.json": "./package.json" },
  };
  await json(join(root, "package.json"), {
    type: "module",
    devDependencies: { typescript: "catalog:" },
  });
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    `packages:\n  - "packages/*"\ncatalog:\n  typescript: ${compilerVersion}\n`,
  );
  await json(join(wrapper, "package.json"), wrapperMetadata);
  await json(join(native, "package.json"), nativeMetadata);
  const candidate = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");\n`;
  for (const path of ["bin/tsc", "lib/tsc.js", "lib/getExePath.js"]) {
    await mkdir(dirname(join(wrapper, path)), { recursive: true });
    await writeFile(join(wrapper, path), candidate);
  }
  const executable = join(native, "lib", process.platform === "win32" ? "tsc.exe" : "tsc");
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, "inert native marker; never execute\n", { mode: 0o755 });
  return { root, wrapper, native, marker, wrapperMetadata, nativeMetadata, executable };
}

async function copyInstalledWrapper(destination: string): Promise<void> {
  for (const path of ["package.json", "bin/tsc", "lib/tsc.js", "lib/getExePath.js"]) {
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await cp(join(repositoryRoot, "node_modules/typescript", path), join(destination, path));
  }
}

function registerCompilerMetadataTests(): void {
  void test("compiler admission reads wrapper and native metadata without executing candidate code", async (context) => {
    const fixture = await compilerFixture(context);
    const admitted = await admitRepositoryTypeScript(fixture.root);
    assert.equal(admitted.version, compilerVersion);
    assert.equal(admitted.entry, join(fixture.wrapper, "bin/tsc"));
    await assert.rejects(readFile(fixture.marker), { code: "ENOENT" });
  });

  void test("compiler admission rejects missing, obsolete, foreign and inconsistent installed identities", async (context) => {
    const cases: readonly [
      string,
      (fixture: Awaited<ReturnType<typeof compilerFixture>>) => Promise<unknown>,
    ][] = [
      ["missing wrapper manifest", (f) => rm(join(f.wrapper, "package.json"))],
      [
        "obsolete declared compiler",
        (f) => writeFile(join(f.root, "pnpm-workspace.yaml"), "catalog:\n  typescript: 6.0.0\n"),
      ],
      [
        "floating declared compiler",
        (f) => writeFile(join(f.root, "pnpm-workspace.yaml"), "catalog:\n  typescript: ^7.0.2\n"),
      ],
      [
        "foreign wrapper",
        (f) =>
          json(join(f.wrapper, "package.json"), { ...f.wrapperMetadata, name: "not-typescript" }),
      ],
      [
        "obsolete wrapper",
        (f) => json(join(f.wrapper, "package.json"), { ...f.wrapperMetadata, version: "6.0.0" }),
      ],
      [
        "foreign wrapper entry",
        (f) =>
          json(join(f.wrapper, "package.json"), {
            ...f.wrapperMetadata,
            bin: { tsc: "./foreign.js" },
          }),
      ],
      [
        "foreign resolver selection",
        (f) =>
          json(join(f.wrapper, "package.json"), {
            ...f.wrapperMetadata,
            imports: { "#getExePath": "./foreign.js" },
          }),
      ],
      [
        "native declaration differs",
        (f) =>
          json(join(f.wrapper, "package.json"), {
            ...f.wrapperMetadata,
            optionalDependencies: { [nativeName]: "6.0.0" },
          }),
      ],
      ["missing native manifest", (f) => rm(join(f.native, "package.json"))],
      [
        "foreign native",
        (f) =>
          json(join(f.native, "package.json"), { ...f.nativeMetadata, name: "not-typescript" }),
      ],
      [
        "obsolete native",
        (f) => json(join(f.native, "package.json"), { ...f.nativeMetadata, version: "6.0.0" }),
      ],
      [
        "conditional native metadata",
        (f) =>
          json(join(f.native, "package.json"), {
            ...f.nativeMetadata,
            exports: { "./package.json": { require: "./package.json", import: "./foreign.json" } },
          }),
      ],
      ["missing native executable", (f) => rm(f.executable)],
    ];
    for (const [name, mutate] of cases) {
      await context.test(name, async (item) => {
        const fixture = await compilerFixture(item);
        await mutate(fixture);
        await assert.rejects(admitRepositoryTypeScript(fixture.root));
        await assert.rejects(readFile(fixture.marker), { code: "ENOENT" });
      });
    }
  });

  void test("compiler admission observes the native package selected from the physical wrapper issuer", async (context) => {
    const fixture = await compilerFixture(context);
    await json(join(fixture.wrapper, "lib/node_modules", nativeName, "package.json"), {
      ...fixture.nativeMetadata,
      version: "6.0.0",
    });
    await assert.rejects(admitRepositoryTypeScript(fixture.root), /native identity, version/u);
    await assert.rejects(readFile(fixture.marker), { code: "ENOENT" });
  });

  void test("compiler admission rejects a conditional native export even when its selected metadata claims canonical exports", async (context) => {
    const fixture = await compilerFixture(context);
    await json(join(fixture.native, "package.json"), {
      ...fixture.nativeMetadata,
      exports: {
        "./package.json": { require: "./selected/package.json", import: "./other/package.json" },
      },
    });
    await json(join(fixture.native, "selected/package.json"), fixture.nativeMetadata);
    const executable = join(
      fixture.native,
      "selected/lib",
      process.platform === "win32" ? "tsc.exe" : "tsc",
    );
    await mkdir(dirname(executable), { recursive: true });
    await cp(fixture.executable, executable);
    await assert.rejects(
      admitRepositoryTypeScript(fixture.root),
      /native identity, version or metadata export/u,
    );
    await assert.rejects(readFile(fixture.marker), { code: "ENOENT" });
  });
}

function registerCompilerLayoutTests(): void {
  void test("compiler admission rejects source-build selection by the byte-exact installed wrapper", async (context) => {
    for (const layout of ["_packages/typescript", "built/npm/typescript"]) {
      await context.test(layout, async (item) => {
        const fixture = await compilerFixture(item);
        const owner = join(fixture.root, "node_modules", layout);
        await copyInstalledWrapper(owner);
        await rm(fixture.wrapper, { recursive: true });
        await symlink(owner, fixture.wrapper, "junction");
        await assert.rejects(admitRepositoryTypeScript(fixture.root), /source-build layouts/u);
        await assert.rejects(readFile(fixture.marker), { code: "ENOENT" });
      });
    }
  });

  void test("compiler admission rejects nested package scopes before official wrapper resolution", async (context) => {
    for (const directory of ["bin", "lib"]) {
      await context.test(directory, async (item) => {
        const fixture = await compilerFixture(item);
        await copyInstalledWrapper(fixture.wrapper);
        await json(join(fixture.wrapper, directory, "package.json"), {
          type: "module",
          imports: { "#getExePath": "./selected.js" },
        });
        await writeFile(
          join(fixture.wrapper, directory, "selected.js"),
          `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(fixture.marker)}, "executed");\nexport default () => ${JSON.stringify(fixture.executable)};\n`,
        );
        await assert.rejects(admitRepositoryTypeScript(fixture.root), /nested package scope/u);
        await assert.rejects(readFile(fixture.marker), { code: "ENOENT" });
      });
    }
  });

  void test("compiler admission rejects in-package aliases of official wrapper files", async (context) => {
    for (const path of ["bin/tsc", "lib/tsc.js", "lib/getExePath.js"]) {
      await context.test(path, async (item) => {
        const fixture = await compilerFixture(item);
        await copyInstalledWrapper(fixture.wrapper);
        const selected = join(fixture.wrapper, path);
        const aliased = join(fixture.wrapper, "different/scope", path);
        await mkdir(dirname(aliased), { recursive: true });
        await cp(selected, aliased);
        await rm(selected);
        await symlink(aliased, selected, "file");
        await assert.rejects(admitRepositoryTypeScript(fixture.root), /wrapper file aliases/u);
        await assert.rejects(readFile(fixture.marker), { code: "ENOENT" });
      });
    }
  });
}

function registerCompilerLaunchTests(): void {
  void test("compiler admission protects all four root launch routes before a stale wrapper can run", async (context) => {
    const fixture = await compilerFixture(context);
    await json(join(fixture.wrapper, "package.json"), {
      ...fixture.wrapperMetadata,
      version: "6.0.0",
    });
    await cp(join(repositoryRoot, "tools"), join(fixture.root, "tools"), { recursive: true });
    for (const path of [
      "architecture/foundation/repository-runtime.json",
      "packages/engineering-foundation/src/process-execution/node-runtime-verifier.ts",
    ]) {
      await mkdir(dirname(join(fixture.root, path)), { recursive: true });
      await cp(join(repositoryRoot, path), join(fixture.root, path));
    }
    const runtime = await resolveQualificationExecutables("bun");
    const environment = {
      ...process.env,
      AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: runtime.node,
      AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: runtime.bun,
      AGENT_TEAMS_FOUNDATION_SOURCE_SHA: "a".repeat(40),
      AGENT_TEAMS_FOUNDATION_PROFILE_ROOT: fixture.root,
    };
    const compilerCommands = [
      "build",
      "parser-spike:typecheck",
      "typecheck:agent-workflow",
      "typecheck:ci-tooling",
      "typecheck:local-mode-oracles",
      "typecheck:managed-runtime-tests",
      "typecheck:native-api-tests",
      "typecheck:native-release-tooling",
      "typecheck:restoration-lock",
      "typecheck:restoration-lock-inputs",
    ];
    assert.deepEqual(
      Object.entries(TOOL_COMMANDS)
        .filter(([, command]) => command.entry === "node_modules/typescript/bin/tsc")
        .map(([id]) => id)
        .toSorted(),
      compilerCommands,
    );
    const commands = [
      ["tools/dev.mts", "build"],
      ["tools/qualify-native-tools.mts"],
      ...compilerCommands.map((id) => ["tools/repository-command.mts", "tool", id]),
    ];
    for (const launcher of [runtime.node, runtime.bun]) {
      assert.ok(launcher !== undefined && launcher.length > 0);
      for (const [entry, ...args] of commands) {
        assert.ok(entry);
        const result = spawnSync(launcher, [join(fixture.root, entry), ...args], {
          cwd: fixture.root,
          env: {
            ...environment,
            AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: launcher === runtime.node ? "node" : "bun",
          },
          encoding: "utf8",
          timeout: 15_000,
        });
        assert.ifError(result.error);
        assert.notEqual(result.status, 0, `${entry} ${args.join(" ")}`);
        assert.match(result.stderr, /TypeScript wrapper identity, version/u);
        await assert.rejects(readFile(fixture.marker), { code: "ENOENT" });
      }
    }
    await assert.rejects(
      verifyPackedScaffoldingQualification({
        fixture: { consumerRoot: fixture.root },
        repositoryRoot: fixture.root,
      }),
      /TypeScript wrapper identity, version/u,
    );
    await assert.rejects(readFile(join(fixture.root, "scaffold-qualification.test.mjs")), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(fixture.marker), { code: "ENOENT" });
  });

  void test("compiler admission accepts the actual installed compiler for successful and rejecting strict checks", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "repository-admitted-typecheck-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const compiler = await admitRepositoryTypeScript(repositoryRoot);
    const source = join(root, "input.ts");
    await json(join(root, "tsconfig.json"), {
      compilerOptions: { strict: true, noEmit: true, types: [], target: "ES2024" },
      files: ["input.ts"],
    });
    const execute = () =>
      spawnSync(process.execPath, [compiler.entry, "--project", join(root, "tsconfig.json")], {
        encoding: "utf8",
        timeout: 30_000,
      });
    await writeFile(source, "export const value: number = 1;\n");
    const passed = execute();
    assert.ifError(passed.error);
    assert.equal(passed.status, 0, `${passed.stdout}${passed.stderr}`);
    await writeFile(source, 'export const value: number = "invalid";\n');
    const rejected = execute();
    assert.ifError(rejected.error);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stdout, /TS2322/u);
  });
}

export function registerRepositoryCompilerAdmissionTests(): void {
  registerCompilerMetadataTests();
  registerCompilerLayoutTests();
  registerCompilerLaunchTests();
}
