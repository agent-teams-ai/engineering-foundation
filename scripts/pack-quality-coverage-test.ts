import { assertUnknownCastRejected } from "./packed-quality-lint-protections.ts";
import { writeQualityLayout } from "./packed-quality-layout.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { runCommand } from "./pack-test-support.mjs";
import {
  inspectCompressedTarArchive,
  readRegularArchive,
  sha256,
} from "./pack-artifact-archive.mjs";
import { copyInstalledClosure } from "./pack-quality-closure.mjs";
import { qualifyPackedQualityAssets } from "./pack-quality-assets.ts";

export { copyInstalledClosure };
export {
  invokeInstalledTypecheck,
  qualifyExternalDeclaration,
} from "./packed-quality-typecheck.ts";
import { invokeInstalledTypecheck } from "./packed-quality-typecheck.ts";
import { qualifyNestedRejections } from "./packed-quality-rejections.ts";
import { qualifyInstalledInputDrift } from "./packed-quality-input-drift.ts";
import { runQualityCommand } from "./packed-quality-command.ts";
import { qualityFixtureRecord, qualityFixtureReport } from "./quality-command-report.ts";
import type { QualifiedArchiveRecord } from "./package-artifact-custody.mts";
import type { QualityFixtureInvoke } from "./packed-quality-lint-protections.ts";
import type { FixturePut } from "./packed-quality-layout.ts";

/** Reuse the installed archive closure in an isolated consumer, never the source installation. */
export async function assertInstalledQualityArtifact({
  consumerRoot,
  artifact,
}: {
  consumerRoot: string;
  artifact: QualifiedArchiveRecord;
}) {
  const bytes = await readRegularArchive(artifact.archivePath);
  assert.equal(sha256(bytes), artifact.sha256, "Packed quality archive identity changed");
  const installed = await realpath(
    join(consumerRoot, "node_modules/@agent-teams/engineering-foundation"),
  );
  const entries = inspectCompressedTarArchive(bytes, artifact.packageName).entries;
  for (const entry of entries) {
    if (entry.type !== "0") {
      continue;
    }
    assert.ok(entry.name.startsWith("package/"));
    const suffix = entry.name.slice("package/".length);
    const path = join(installed, suffix);
    const relativePath = relative(installed, path);
    assert.ok(!isAbsolute(relativePath) && relativePath.split(/[\\/]/u)[0] !== "..");
    assert.ok((await readFile(path)).equals(entry.data), "Installed candidate differs: " + suffix);
  }
}

export async function testPackedQualityCoverage({
  consumerRoot,
  artifact,
}: {
  consumerRoot: string;
  artifact: QualifiedArchiveRecord;
}) {
  await assertInstalledQualityArtifact({ consumerRoot, artifact });
  const installed = join(consumerRoot, "node_modules/@agent-teams/engineering-foundation");
  for (const id of [
    "foundation-config/v3",
    "quality-format-coverage/v1",
    "quality-source-coverage/v5",
    "quality-source-topology/v1",
  ]) {
    const expected = await readFile(join(installed, `schemas/${id}.schema.json`), "utf8");
    const actual = await runQualityCommand(
      [join(installed, "dist/cli.js"), "schema", id],
      consumerRoot,
    );
    assert.equal(actual.code, 0, actual.stderr);
    assert.equal(actual.stdout, expected, `Installed public schema load differs: ${id}`);
  }
  const root = await qualifyLayout({ consumerRoot, nested: false, rootPackage: true, artifact });
  const flat = await qualifyLayout({ consumerRoot, nested: false, artifact });
  const nested = await qualifyLayout({ consumerRoot, nested: true, artifact });
  return { outcome: "passed", consumers: [root, flat, nested] };
}

async function qualifyLayout({
  consumerRoot,
  nested,
  rootPackage = false,
  artifact,
}: {
  consumerRoot: string;
  nested: boolean;
  rootPackage?: boolean;
  artifact: QualifiedArchiveRecord;
}) {
  const root = join(
    dirname(consumerRoot),
    rootPackage
      ? "quality coverage root consumer"
      : nested
        ? "quality coverage nested consumer"
        : "quality coverage flat consumer",
  );
  await mkdir(root, { recursive: true });
  const physicalRoot = await realpath(root);
  await copyInstalledClosure(join(consumerRoot, "node_modules"), join(root, "node_modules"));
  await assertInstalledQualityArtifact({ consumerRoot: root, artifact });
  if (!nested) {
    const schema = join(
      root,
      "node_modules/@agent-teams/engineering-foundation/schemas/foundation-config/v2.schema.json",
    );
    const original = await readFile(schema);
    try {
      await writeFile(schema, "{}\n");
      await assert.rejects(assertInstalledQualityArtifact({ consumerRoot: root, artifact }), {
        code: "ERR_ASSERTION",
        message: "Installed candidate differs: schemas/foundation-config/v2.schema.json",
      });
    } finally {
      await writeFile(schema, original);
    }
    await assertInstalledQualityArtifact({ consumerRoot: root, artifact });
  }
  const put: FixturePut = async (path, value) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(
      join(root, path),
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    );
  };
  const devDependencies: Record<string, string> = {};
  for (const name of ["@agent-teams/engineering-foundation", "stack-toolchain"]) {
    const manifestPath = await realpath(join(root, "node_modules", name, "package.json"));
    const suffix = relative(physicalRoot, manifestPath);
    assert.ok(
      !isAbsolute(suffix) && !suffix.startsWith(".."),
      `Packed dependency escapes consumer: ${name}`,
    );
    const version = qualityFixtureRecord(JSON.parse(await readFile(manifestPath, "utf8")))[
      "version"
    ];
    assert.ok(typeof version === "string");
    devDependencies[name] = version;
  }
  const { moduleRoot, sourceRoot, main, scripts, activation } = await writeQualityLayout({
    nested,
    rootPackage,
    devDependencies,
    put,
  });
  const cli = join(root, "node_modules/@agent-teams/engineering-foundation/dist/cli.js");
  const invoke: QualityFixtureInvoke = async (args, code = 0) => {
    const result = await runQualityCommand(
      [cli, ...args, "--consumer", root, "--format", "json"],
      root,
    );
    assert.equal(result.code, code, result.stdout || result.stderr);
    return qualityFixtureReport(result.stdout);
  };
  assert.equal((await invoke(["check", "quality.source-coverage"])).outcome, "passed");
  assert.equal((await invoke(["quality", "check", "--scope-only"])).outcome, "passed");
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await qualifyCastBridge({ root, put, invoke, main });
  await put(main, "export const value = 1;\nPromise.resolve(2);\n");
  const rejected = await invoke(["quality", "check"], 1);
  assert.ok(
    rejected.capabilities[0].diagnostics.some(
      ({ location, evidence }) =>
        location.path === main &&
        evidence.some(({ value }) => value === "typescript(no-floating-promises)"),
    ),
  );
  await put(
    main,
    "export const value = 1;\n// eslint-disable-next-line typescript/no-floating-promises\nPromise.resolve(2);\n",
  );
  const disabled = await invoke(["quality", "check"], 1);
  assert.ok(
    disabled.capabilities[0].diagnostics.some(({ evidence }) =>
      evidence.some(
        ({ kind, value }) => kind === "tool-rule" && value === "typescript(no-floating-promises)",
      ),
    ),
  );
  await put(main, "export const value = 1;\nvoid Promise.resolve(2);\n");
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  const drift = rootPackage
    ? await qualifyInstalledInputDrift({ root, cli, main, put, invoke })
    : undefined;
  if (nested) {
    await qualifyPackedQualityAssets({ root, put, invoke, sourceRoot, boundaryId: "worker" });
    await qualifyNestedRejections({
      root,
      put,
      invoke,
      main,
      sourceRoot,
      moduleRoot,
      scripts,
      devDependencies,
      activation,
      invokeTypecheck: () => invokeInstalledTypecheck(root),
    });
  }
  await assertInstalledQualityArtifact({ consumerRoot: root, artifact });
  return {
    outcome: "passed",
    consumerRoot: root,
    foundationVersion: devDependencies["@agent-teams/engineering-foundation"],
    ...(drift === undefined ? {} : { inputDrift: drift }),
  };
}

async function qualifyCastBridge({
  root,
  put,
  invoke,
  main,
}: {
  root: string;
  put: FixturePut;
  invoke: QualityFixtureInvoke;
  main: string;
}): Promise<void> {
  const tuple = "export const values = [1, 2] as unknown as readonly [number, number];\n";
  await put(main, tuple);
  const castRejected = await invoke(["quality", "check"], 1);
  assertUnknownCastRejected(castRejected, main);
  const expression = "[1, 2] as unknown as readonly [number, number]";
  const start = tuple.indexOf(expression);
  await put(
    "tests/tuple-rejection.test.mjs",
    `import assert from "node:assert/strict";\nimport test from "node:test";\ntest("tuple representation preserves order and duplicates", () => {\n  assert.deepEqual([[1], [1, 2]].flat(), [1, 1, 2]);\n  assert.notDeepEqual([[1], [1, 2]].flat(), [1, 2]);\n});\n`,
  );
  await runCommand(process.execPath, ["--test", "tests/tuple-rejection.test.mjs"], root);
  await put("bridges.json", {
    schemaVersion: 1,
    bridges: [
      {
        path: main,
        start,
        end: start + expression.length,
        sha256: createHash("sha256").update(expression).digest("hex"),
        rationale: "Exact tuple representation retains array order and duplicate values.",
        rejectingTest: "tests/tuple-rejection.test.mjs",
      },
    ],
  });
  const qualified = qualityFixtureRecord(
    JSON.parse(await readFile(join(root, "quality.yaml"), "utf8")),
  );
  await put("quality.yaml", {
    ...qualified,
    schemaVersion: 5,
    bridgeAdmissionsPath: "bridges.json",
  });
  assert.equal((await invoke(["quality", "check"])).outcome, "passed");
  await put("bridges.json", { schemaVersion: 1, bridges: [] });
  assert.equal((await invoke(["quality", "check"], 1)).outcome, "violations");
  await put("quality.yaml", qualified);
  await put(main, "export const value = 1;\n");
}
