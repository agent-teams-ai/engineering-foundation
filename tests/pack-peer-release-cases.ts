import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { runNpmCommand } from "../scripts/pack-test-support.mjs";
import { qualifiedArchive } from "./pack-publishable-artifacts-support.mjs";
import { repositorySourceRoot } from "./support/repository-source.ts";
import {
  manifestFixtureRecord,
  canonicalFixtureManifest,
} from "./pack-manifest-authority-cases.ts";

function releaseItems(
  value: unknown,
): { name: string; oldVersion: string; newVersion: string; type: string }[] {
  const releases = manifestFixtureRecord(value)["releases"];
  assert.ok(Array.isArray(releases));
  return releases.map((entry: unknown) => {
    const record = manifestFixtureRecord(entry);
    const name = record["name"];
    const oldVersion = record["oldVersion"];
    const newVersion = record["newVersion"];
    const type = record["type"];
    assert.ok(
      typeof name === "string" &&
        typeof oldVersion === "string" &&
        typeof newVersion === "string" &&
        typeof type === "string",
    );
    return { name, oldVersion, newVersion, type };
  });
}

async function assertPendingFoundationRelease(): Promise<void> {
  const root = await repositorySourceRoot();
  const require = createRequire(import.meta.url);
  const changesets = createRequire(require.resolve("@changesets/cli/package.json"));
  const module = manifestFixtureRecord(changesets("@changesets/get-release-plan"));
  const getReleasePlan = module["default"];
  assert.ok(typeof getReleasePlan === "function");
  const plan = releaseItems(await Reflect.apply(getReleasePlan, undefined, [root]));
  const foundationName = "@agent-teams/engineering-foundation";
  const foundation = plan.find((release) => release.name === foundationName);
  // A version PR has consumed the pending train; no dependency transition remains.
  if (foundation === undefined || foundation.newVersion === foundation.oldVersion) {
    return;
  }
  const manifest = manifestFixtureRecord(
    JSON.parse(
      await readFile(
        new URL("../packages/feature-module-standard/package.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const rootManifest = manifestFixtureRecord(
    JSON.parse(await readFile(join(root, "package.json"), "utf8")),
  );
  const workspaces = manifestFixtureRecord(rootManifest["workspaces"]);
  const catalogVersions = new Map(
    Object.entries(manifestFixtureRecord(workspaces["catalog"])).map(([name, version]) => {
      assert.ok(typeof version === "string");
      return [name, version];
    }),
  );
  const project = (version: string) =>
    canonicalFixtureManifest(manifest, {
      catalogVersions,
      internalPackageVersions: new Map([[foundationName, version]]),
    });
  const before = project(foundation.oldVersion);
  const after = project(foundation.newVersion);
  assert.equal(
    manifestFixtureRecord(before["peerDependencies"])[foundationName],
    "^1.8.0 || ^2.0.0 || ^3.0.0 || ^4.0.0",
  );
  assert.equal(
    manifestFixtureRecord(after["peerDependencies"])[foundationName],
    "^1.8.0 || ^2.0.0 || ^3.0.0 || ^4.0.0",
  );
  assert.equal(
    manifestFixtureRecord(before["devDependencies"])[foundationName],
    foundation.oldVersion,
  );
  assert.equal(
    manifestFixtureRecord(after["devDependencies"])[foundationName],
    foundation.newVersion,
  );
  assert.notDeepEqual(before, after, "The exact dev dependency still alters published FMS bytes");
  const fms = plan.find((release) => release.name === manifest["name"]);
  assert.ok(
    fms && fms.type !== "none" && fms.newVersion !== fms.oldVersion,
    "Changed packed FMS bytes require a new FMS version; an optional compatible peer does not make existing npm bytes mutable",
  );
  if (foundation.newVersion === "2.0.0" && manifest["version"] === "0.1.2") {
    assert.equal(
      fms.newVersion,
      "0.2.0",
      "The compatible peer-window expansion must keep FMS on its intended 0.x minor train",
    );
  }
}

async function assertOfficialChangesetRelease(t: TestContext): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "fms-compatible-release-TEST-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Status consults Git's base; borrow only committed objects, with fixture-owned refs.
  const sourceRoot = await repositorySourceRoot();
  const clone = spawnSync(
    "git",
    ["clone", "--shared", "--no-checkout", "--quiet", sourceRoot, root],
    { encoding: "utf8" },
  );
  assert.equal(clone.status, 0, clone.stdout + clone.stderr);
  const base = spawnSync("git", ["update-ref", "refs/heads/main", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(base.status, 0, base.stdout + base.stderr);
  const require = createRequire(import.meta.url);
  const cli = require.resolve("@changesets/cli/bin.js");
  const foundationName = "@agent-teams/engineering-foundation";
  const standardName = "@agent-teams/feature-module-standard";
  const config = manifestFixtureRecord(
    JSON.parse(await readFile(new URL("../.changeset/config.json", import.meta.url), "utf8")),
  );
  const standard = manifestFixtureRecord(
    JSON.parse(
      await readFile(
        new URL("../packages/feature-module-standard/package.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  await mkdir(join(root, ".changeset"));
  await writeFile(join(root, "DISPOSABLE_SANDBOX"), "Official Changesets release-plan fixture.\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fms-release-TEST", private: true, workspaces: ["packages/*"] }),
  );
  await writeFile(
    join(root, ".changeset/config.json"),
    JSON.stringify({ ...config, changelog: false }),
  );
  for (const [directory, manifest] of [
    ["foundation", { name: foundationName, version: "1.10.1" }],
    [
      "standard",
      {
        name: standardName,
        version: "0.1.2",
        peerDependencies: standard["peerDependencies"],
        peerDependenciesMeta: standard["peerDependenciesMeta"],
        devDependencies: { [foundationName]: "workspace:*" },
      },
    ],
  ] as const) {
    await mkdir(join(root, "packages", directory), { recursive: true });
    await writeFile(join(root, "packages", directory, "package.json"), JSON.stringify(manifest));
  }
  await writeFile(
    join(root, ".changeset/compatible-release.md"),
    [
      "---",
      `"${foundationName}": major`,
      `"${standardName}": minor`,
      "---",
      "",
      "Compatible peer window TEST release.",
      "",
    ].join("\n"),
  );
  const run = (args: readonly string[]) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  run(["status", "--output", "release-plan.json"]);
  const plan = releaseItems(JSON.parse(await readFile(join(root, "release-plan.json"), "utf8")));
  const versions = Object.fromEntries(plan.map(({ name, newVersion }) => [name, newVersion]));
  assert.deepEqual(versions, { [foundationName]: "2.0.0", [standardName]: "0.2.0" });
  run(["version"]);
  const versioned = manifestFixtureRecord(
    JSON.parse(await readFile(join(root, "packages/standard/package.json"), "utf8")),
  );
  assert.equal(versioned["version"], "0.2.0");
  // The official versioner may retain workspace:; the canonical pack must strip it.
  assert.equal(
    manifestFixtureRecord(
      canonicalFixtureManifest(versioned, {
        catalogVersions: new Map(),
        internalPackageVersions: new Map([[foundationName, "2.0.0"]]),
      })["peerDependencies"],
    )[foundationName],
    "^1.8.0 || ^2.0.0 || ^3.0.0 || ^4.0.0",
  );
  assert.equal(
    manifestFixtureRecord(
      JSON.parse(await readFile(join(root, "packages/foundation/package.json"), "utf8")),
    )["version"],
    "2.0.0",
  );
  t.diagnostic(`Official Changesets release plan: ${JSON.stringify(versions)}`);
}

async function assertInstalledPeerVersions(t: TestContext): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "fms-strict-peers-TEST-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const foundationName = "@agent-teams/engineering-foundation";
  const standard = manifestFixtureRecord(
    JSON.parse(
      await readFile(
        new URL("../packages/feature-module-standard/package.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  assert.ok(typeof standard["name"] === "string");
  const packed = canonicalFixtureManifest(
    {
      name: standard["name"],
      version: "0.2.0",
      peerDependencies: standard["peerDependencies"],
      peerDependenciesMeta: standard["peerDependenciesMeta"],
    },
    {
      catalogVersions: new Map(),
      internalPackageVersions: new Map([[foundationName, "2.0.0"]]),
    },
  );
  await writeFile(join(root, "standard.tgz"), qualifiedArchive(packed));
  for (const version of ["1.8.0", "2.0.0", "3.0.0", "4.0.0", "1.7.9", "5.0.0", "4.0.0-rc.0"]) {
    const consumer = join(root, version);
    await mkdir(consumer);
    await writeFile(
      join(consumer, "foundation.tgz"),
      qualifiedArchive({ name: foundationName, version }),
    );
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: {
          [foundationName]: "file:./foundation.tgz",
          [standard["name"]]: "file:../standard.tgz",
        },
      }),
    );
    const install = runNpmCommand(
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--strict-peer-deps",
        "--no-audit",
        "--no-fund",
        "--cache",
        join(root, "cache"),
      ],
      consumer,
      { timeoutMs: 30_000 },
    );
    if (["1.8.0", "2.0.0", "3.0.0", "4.0.0"].includes(version)) {
      await install;
    } else {
      await assert.rejects(
        install,
        (error: unknown) =>
          error !== null &&
          typeof error === "object" &&
          "stderr" in error &&
          typeof error.stderr === "string" &&
          /ERESOLVE/u.test(error.stderr),
      );
    }
  }
}

export function registerPeerReleaseTests(): void {
  void test(
    "pending Foundation releases version FMS when its canonical packed manifest changes",
    assertPendingFoundationRelease,
  );
  void test(
    "official Changesets status and version keep the compatible Foundation 2 FMS release on 0.x",
    assertOfficialChangesetRelease,
  );
}

export function registerPeerInstallTests(): void {
  void test(
    "packed FMS peer union admits the minimum and Foundation 2 through 4 under strict peers only",
    assertInstalledPeerVersions,
  );
}
