import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { publishablePackageCheckPlan } from "../scripts/check-publishable-packages.mjs";
import { releaseGraphProjectionDiagnostics } from "../scripts/check-release-graph-projections.mjs";
import {
  derivePublishablePackageProjection,
  PUBLISHABLE_PACKAGE_DEPENDENCIES,
  PUBLISHABLE_PACKAGES,
} from "../scripts/publishable-packages.mjs";
import { builtTestArguments } from "../scripts/run-built-tests.mjs";
import { testRootsForPackages } from "../scripts/check-test-manifests.mjs";

const execFileAsync = promisify(execFile);

function entry(name) {
  const slug = name.split("/").at(-1);
  return {
    changelogPath: `packages/${slug}/CHANGELOG.md`,
    manifestPath: `packages/${slug}/package.json`,
    name,
    root: `packages/${slug}`,
  };
}

function projection(catalog, dependencyEntries = {}) {
  return derivePublishablePackageProjection({
    catalog,
    manifestsByName: new Map(catalog.map(({ name }) => [name, {
      name,
      ...dependencyEntries[name],
    }])),
  });
}

async function isIgnored(repository, path) {
  try {
    await execFileAsync("git", ["-C", repository, "check-ignore", "--quiet", path]);
    return true;
  } catch (error) {
    if (error?.code === 1) {
      return false;
    }
    throw error;
  }
}

test("manifest edges determine stable publication order independently of catalog order", () => {
  const base = entry("@fixture/base");
  const alpha = entry("@fixture/alpha");
  const omega = entry("@fixture/omega");
  const manifests = {
    [alpha.name]: { dependencies: { [base.name]: "workspace:*" } },
    [omega.name]: { devDependencies: { [base.name]: "workspace:*" } },
  };
  const forward = projection([omega, base, alpha], manifests);
  const reverse = projection([alpha, base, omega], manifests);
  const expected = [base.name, alpha.name, omega.name];
  assert.deepEqual(forward.packages.map(({ name }) => name), expected);
  assert.deepEqual(reverse.packages.map(({ name }) => name), expected);
  assert.deepEqual(forward.dependencies, reverse.dependencies);
  assert.deepEqual(forward.dependencies[omega.name], []);
  assert.deepEqual(forward.declarations[omega.name], [
    { name: base.name, section: "devDependencies" },
  ]);
});

test("manifest projection rejects cycles, unknown workspace targets, and malformed references", () => {
  const left = entry("@fixture/left");
  const right = entry("@fixture/right");
  assert.throws(() => projection([left, right], {
    [left.name]: { dependencies: { [right.name]: "workspace:*" } },
    [right.name]: { dependencies: { [left.name]: "workspace:*" } },
  }), /dependency cycle/u);
  assert.throws(() => projection([left], {
    [left.name]: { dependencies: { "@fixture/unknown": "workspace:*" } },
  }), /unknown internal workspace package/u);
  assert.throws(() => projection([left], {
    [left.name]: { dependencies: [] },
  }), /dependencies must be an object/u);
  assert.throws(() => projection([left, right], {
    [left.name]: { dependencies: { [right.name]: "workspace:^" } },
  }), /as workspace:\*/u);
  assert.throws(() => projection([{ ...left, dependencies: [] }]), /metadata only/u);
});

test("current projection qualifies the adapter and retains current Foundation edges", () => {
  assert.deepEqual(PUBLISHABLE_PACKAGES.map(({ name }) => name), [
    "@agent-teams/repository-mutation",
    "@agent-teams/engineering-foundation",
    "@agent-teams/docs-protocol",
    "@agent-teams/docs-protocol-agent-teams",
    "@agent-teams/docs-protocol-mcp",
  ]);
  assert.deepEqual(
    PUBLISHABLE_PACKAGE_DEPENDENCIES["@agent-teams/docs-protocol-agent-teams"],
    [
      "@agent-teams/docs-protocol",
      "@agent-teams/engineering-foundation",
      "@agent-teams/repository-mutation",
    ].toSorted(),
  );
});

test("package checks and built tests consume dynamic projected inventories", () => {
  assert.deepEqual(publishablePackageCheckPlan([
    { root: "packages/one" },
    { root: "packages/two" },
  ]), [
    { arguments: ["packages/one"], tool: "publint" },
    { arguments: ["--pack", "--profile", "esm-only", "packages/one"], tool: "attw" },
    { arguments: ["packages/two"], tool: "publint" },
    { arguments: ["--pack", "--profile", "esm-only", "packages/two"], tool: "attw" },
  ]);
  assert.deepEqual(builtTestArguments({ tests: [
    "tests/one.test.mjs",
    "packages/one/tests/two.test.mjs",
  ] }), [
    "--test",
    "--test-concurrency=1",
    "tests/one.test.mjs",
    "packages/one/tests/two.test.mjs",
  ]);
});

test("qualified package test roots are explicit and reject traversal", () => {
  assert.ok(testRootsForPackages(PUBLISHABLE_PACKAGES).includes(
    "packages/docs-protocol-agent-teams/tests",
  ));
  assert.throws(
    () => testRootsForPackages([{ root: "packages/../outside" }]),
    /not bounded and portable/u,
  );
});

test("qualified package outputs are ignored without hiding package inputs", async (t) => {
  const repository = await mkdtemp(join(tmpdir(), "root-package-projection-ignore-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await execFileAsync("git", ["-C", repository, "init", "--quiet"]);
  await writeFile(
    join(repository, ".gitignore"),
    await readFile(new URL("../.gitignore", import.meta.url), "utf8"),
  );

  const packageRoot = join(repository, "packages", "qualified-adapter");
  const observableFiles = [
    "package.json",
    "src/index.ts",
    "schemas/contract.schema.json",
    "assets/prompt.md",
    "fixtures/example.json",
  ];
  const generatedFiles = ["dist/index.js", "LICENSE"];
  for (const path of [...observableFiles, ...generatedFiles]) {
    const target = join(packageRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "fixture\n");
  }

  for (const path of generatedFiles) {
    assert.equal(await isIgnored(repository, `packages/qualified-adapter/${path}`), true);
  }
  for (const path of observableFiles) {
    assert.equal(await isIgnored(repository, `packages/qualified-adapter/${path}`), false);
  }
});

test("tsconfig projection compares membership as sets and manifest-derived edges", () => {
  const base = entry("@fixture/base");
  const app = entry("@fixture/app");
  const input = {
    dependencies: { [base.name]: [], [app.name]: [base.name] },
    packages: [base, app],
    packageTsconfigsByName: new Map([
      [base.name, { references: [] }],
      [app.name, { references: [{ path: "../base" }] }],
    ]),
    rootTsconfig: {
      references: [{ path: "./packages/app" }, { path: "./packages/base" }],
    },
  };
  assert.deepEqual(releaseGraphProjectionDiagnostics(input), []);
  input.packageTsconfigsByName.set(app.name, { references: [] });
  assert.match(
    releaseGraphProjectionDiagnostics(input).join("\n"),
    /manifest-derived dependencies/u,
  );
});
