import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { resolvePackagingPnpm } from "../../scripts/packaging-pnpm.ts";
import { resolveQualificationExecutables } from "../../tools/executable-policy.mts";
import { TOOL_COMMANDS } from "../../tools/repository-tool-catalog.ts";
import { ownedTemporaryRoot } from "./repository-ci-workflow-cases.ts";
import { repositorySourceRoot } from "./repository-source.ts";

export async function minimalSource(root: string): Promise<void> {
  const sourceRoot = await repositorySourceRoot();
  await mkdir(join(root, ".worker-tmp/profiles"), { recursive: true });
  await mkdir(join(root, "architecture/foundation"), { recursive: true });
  const manifest = {
    name: "TEST-node-profile-source",
    version: "1.0.0",
    private: true,
    packageManager: "bun@1.4.3",
    workspaces: { packages: ["packages/*"], catalog: {}, catalogs: {} },
    catalog: {},
    catalogs: {},
    overrides: {},
  };
  await writeFile(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    'packages:\n  - "packages/*"\ncatalog: {}\ncatalogs: {}\noverrides: {}\n',
    "utf8",
  );
  await copyFile(
    join(sourceRoot, "architecture/foundation/repository-agent-workflow.yaml"),
    join(root, "architecture/foundation/repository-agent-workflow.yaml"),
  );
  await copyFile(
    join(sourceRoot, "architecture/foundation/dependency-declarations.yaml"),
    join(root, "architecture/foundation/dependency-declarations.yaml"),
  );
  await copyFile(
    join(sourceRoot, "architecture/foundation/repository-runtime.json"),
    join(root, "architecture/foundation/repository-runtime.json"),
  );
}

export async function assertNodeOnlyCommandExecution(
  repositoryRoot: string,
  parent: string,
): Promise<void> {
  const bin = join(parent, "bin");
  const fixture = join(parent, "fixture");
  const observation = join(parent, "observation.jsonl");
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  await Promise.all([mkdir(bin), mkdir(fixture)]);
  const linkedNode = join(bin, nodeName);
  await link(process.execPath, linkedNode).catch(async (error: unknown) => {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EXDEV" && code !== "EPERM") {
      throw error;
    }
    await copyFile(process.execPath, linkedNode);
    await chmod(linkedNode, 0o755);
  });
  await writeFile(
    join(fixture, "package.json"),
    `${JSON.stringify(
      {
        name: "TEST-node-command-profile",
        version: "1.0.0",
        private: true,
        packageManager: "pnpm@11.20.0",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  // A generated shell shim also needs utilities absent from this node-only PATH.
  const { entrypoint: managerEntrypoint } = await resolvePackagingPnpm();
  assert.ok(managerEntrypoint);
  const commonEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: bin,
    TMPDIR: parent,
    TEMP: parent,
    TMP: parent,
    pnpm_config_ignore_workspace: "true",
    pnpm_config_verify_deps_before_run: "false",
    AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: process.execPath,
    AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT: managerEntrypoint,
    AGENT_TEAMS_FOUNDATION_RUNTIME_OBSERVATION: observation,
  };
  delete commonEnvironment["AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE"];
  const defaultProfile = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, "tools/repository-command.mts"), "tool", "runtime-observe"],
    {
      cwd: fixture,
      encoding: "utf8",
      env: { ...commonEnvironment, AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: undefined },
      timeout: 10_000,
    },
  );
  assert.notEqual(defaultProfile.status, 0, `${defaultProfile.stdout}${defaultProfile.stderr}`);

  const pnpmVersion = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, "tools/pnpm-command.mts"), "--version"],
    {
      cwd: fixture,
      encoding: "utf8",
      env: { ...commonEnvironment, AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "node" },
      timeout: 20_000,
    },
  );
  assert.equal(pnpmVersion.status, 0, `${pnpmVersion.stdout}${pnpmVersion.stderr}`);
  assert.equal(pnpmVersion.stdout.trim(), "11.20.0");

  const selectedProfile = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, "tools/repository-command.mts"), "tool", "runtime-observe"],
    {
      cwd: fixture,
      encoding: "utf8",
      env: { ...commonEnvironment, AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "node" },
      timeout: 20_000,
    },
  );
  assert.equal(selectedProfile.status, 0, `${selectedProfile.stdout}${selectedProfile.stderr}`);
  const observed = JSON.parse((await readFile(observation, "utf8")).trim()) as {
    readonly profile: string | null;
    readonly leafNodeVersion: string | null;
    readonly leafBunVersion: string | null;
  };
  assert.equal(observed.profile, "node");
  assert.equal(observed.leafNodeVersion, process.versions["node"]);
  assert.equal(observed.leafBunVersion, null);
}

const strictProjects = [
  ["typecheck:ci-tooling", "tsconfig.ci-tooling.json", "ci-tooling.mts"],
  [
    "typecheck:restoration-lock-inputs",
    "tsconfig.restoration-lock-inputs-tests.json",
    "restoration-inputs.mts",
  ],
  [
    "typecheck:restoration-lock",
    "tsconfig.restoration-lock-tests.json",
    "restoration-lock.mts",
  ],
  [
    "typecheck:managed-runtime-tests",
    "tsconfig.managed-runtime-tests.json",
    "managed-runtime.mts",
  ],
  ["typecheck:local-mode-oracles", "tsconfig.local-mode-oracles.json", "local-mode-oracles.ts"],
  ["typecheck:native-api-tests", "tsconfig.native-api-tests.json", "native-api-tests.ts"],
  [
    "typecheck:native-release-tooling",
    "tsconfig.native-release-tooling.json",
    "native-release-tooling.ts",
  ],
  ["typecheck:agent-workflow", "tsconfig.agent-workflow-tests.json", "agent-workflow.ts"],
  // This required project is invoked as a dispatcher tool, not a package script.
  [
    null,
    "spikes/source-dependency-parser/tsconfig.json",
    "spikes/source-dependency-parser/parser-spike.ts",
  ],
] as const;

export async function assertStrictProjectAdmission(repositoryRoot: string): Promise<void> {
  const runtime = await resolveQualificationExecutables("bun");
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
    readonly scripts: Readonly<Record<string, string>>;
  };
  const toolchain = JSON.parse(
    await readFile(join(repositoryRoot, "toolchain.config.json"), "utf8"),
  ) as {
    readonly typecheck: { readonly projects: readonly string[] };
  };
  const valid = "export const value: number = 1;\n";
  const invalid = 'export const value: number = "strict-project-error";\n';
  const compilerOptions = { strict: true, noEmit: true, types: [], target: "ES2024" };
  const root = await ownedTemporaryRoot("strict-project-admission-");
  const dispatcherCommand = [runtime.node, join(repositoryRoot, "tools/repository-command.mts")]
    .map((path) => `'${path.replaceAll("'", "'\\''")}'`)
    .join(" ");
  const run = (id: string) =>
    spawnSync(
      runtime.node,
      [join(repositoryRoot, "tools/repository-command.mts"), "script", id],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: runtime.node,
          AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: runtime.bun,
          AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "bun",
          PATH: `${dirname(runtime.node)}${delimiter}${process.env["PATH"] ?? ""}`,
        },
      },
    );
  try {
    const ids = [
      "build",
      "typecheck",
      ...strictProjects.flatMap(([id]) => (id === null ? [] : [id])),
    ];
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "TEST-strict-project-admission",
        private: true,
        packageManager: "bun@1.4.3",
        scripts: Object.fromEntries(
          ids.map((id) => [
            id,
            manifest.scripts[id]?.replaceAll(
              "node tools/repository-command.mts",
              dispatcherCommand,
            ),
          ]),
        ),
      }),
    );
    await writeFile(join(root, "production.mts"), valid);
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions,
        files: ["production.mts"],
      }),
    );
    assert.deepEqual(TOOL_COMMANDS["typecheck"], {
      entry: "node_modules/stack-toolchain/dist/cli.js",
      args: ["typecheck"],
      role: "node-tool",
    });
    await writeFile(join(root, "lint.json"), "{}");
    await writeFile(
      join(root, "toolchain.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        profile: "typescript-node",
        typecheck: toolchain.typecheck,
        lint: { config: "lint.json", paths: ["."] },
        format: { paths: ["."] },
      }),
    );
    await writeFile(
      join(root, "tsconfig.quality.json"),
      JSON.stringify({
        compilerOptions,
        files: ["production.mts"],
      }),
    );
    for (const [, config, input] of strictProjects) {
      await mkdir(dirname(join(root, config)), { recursive: true });
      await writeFile(join(root, input), valid);
      await writeFile(
        join(root, config),
        JSON.stringify({
          compilerOptions,
          files: [relative(dirname(config), input)],
        }),
      );
    }
    const baseline = run("typecheck");
    assert.equal(baseline.status, 0, `${baseline.stdout}${baseline.stderr}`);
    // A single build with every strict-only input invalid proves their joint exclusion.
    for (const [, , input] of strictProjects) {
      await writeFile(join(root, input), invalid);
    }
    const production = run("build");
    assert.equal(production.status, 0, `${production.stdout}${production.stderr}`);
    for (const [, , input] of strictProjects) {
      await writeFile(join(root, input), valid);
    }
    for (const [, , input] of strictProjects) {
      await writeFile(join(root, input), invalid);
      const rejected = run("typecheck");
      assert.notEqual(
        rejected.status,
        0,
        `typecheck omitted strict project input ${input}: ${rejected.stdout}${rejected.stderr}`,
      );
      assert.match(`${rejected.stdout}${rejected.stderr}`, /error TS2322/u);
      assert.ok(`${rejected.stdout}${rejected.stderr}`.replaceAll("\\", "/").includes(input));
      await writeFile(join(root, input), valid);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
