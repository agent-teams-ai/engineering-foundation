import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { copyPinnedToolchain } from "../tests/features/quality-coverage/copied-toolchain.mjs";
import { runCommand } from "./pack-test-support.mjs";

import { writeQualityLayout } from "./packed-quality-layout.ts";
import type { FixturePut } from "./packed-quality-layout.ts";
import { runQualityCommand } from "./packed-quality-command.ts";
import { qualityFixtureRecord, qualityFixtureReport } from "./quality-command-report.ts";

async function prepareCastFixture(
  physicalConsumer: string,
  pins: Record<string, string>,
  put: FixturePut,
) {
  const manifest = qualityFixtureRecord(
    JSON.parse(await readFile(join(physicalConsumer, "package.json"), "utf8")),
  );
  const { main, scripts } = await writeQualityLayout({ nested: false, devDependencies: pins, put });
  await put("package.json", {
    ...manifest,
    scripts: { ...qualityFixtureRecord(manifest["scripts"] ?? {}), ...scripts },
    devDependencies: { ...qualityFixtureRecord(manifest["devDependencies"] ?? {}), ...pins },
  });
  const quality = qualityFixtureRecord(
    JSON.parse(await readFile(join(physicalConsumer, "quality.yaml"), "utf8")),
  );
  return { main, quality };
}

/** Qualify the public cast gate in the consumer's verified registry installation. */
export async function verifyRegistryQualityCast({
  consumerRoot,
  installedRoot,
}: {
  consumerRoot: string;
  installedRoot: string;
}): Promise<void> {
  const physicalConsumer = await realpath(consumerRoot);
  const physicalFoundation = await realpath(installedRoot);
  assert.equal(
    physicalFoundation,
    await realpath(join(physicalConsumer, "node_modules/@agent-teams/engineering-foundation")),
    "Cast fixture must use the verified registry installation",
  );
  const cli = join(physicalFoundation, "dist/cli.js");
  const installedCliBytes = await readFile(cli);
  const pins = await copyPinnedToolchain(physicalConsumer);
  assert.ok(
    (await readFile(cli)).equals(installedCliBytes),
    "Pinned tools must preserve the verified registry CLI bytes",
  );
  assert.equal(
    await realpath(join(physicalConsumer, "node_modules/@agent-teams/engineering-foundation")),
    physicalFoundation,
    "Pinned tools must preserve the registry-installed Foundation package",
  );
  const put: FixturePut = async (path, value) => {
    const target = join(physicalConsumer, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    );
  };
  const { main, quality } = await prepareCastFixture(physicalConsumer, pins, put);
  const invoke = async (expectedCode: number) => {
    const result = await runQualityCommand(
      [cli, "quality", "check", "--consumer", physicalConsumer, "--format", "json"],
      physicalConsumer,
    );
    assert.equal(result.code, expectedCode, result.stdout || result.stderr);
    return qualityFixtureReport(result.stdout);
  };
  const parser = `export function parsePair(value: unknown): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError("Expected two finite numbers");
  }
  const first: unknown = value[0];
  const second: unknown = value[1];
  if (typeof first !== "number" || !Number.isFinite(first) ||
      typeof second !== "number" || !Number.isFinite(second)) {
    throw new TypeError("Expected two finite numbers");
  }
  return value as unknown as readonly [number, number];
}
`;
  await put(main, parser);
  const rejected = await invoke(1);
  assert.equal(rejected.outcome, "violations");
  assert.ok(
    rejected.capabilities[0].diagnostics.some(
      ({ ruleId, location }) =>
        ruleId === "quality.source-coverage.explicit-unknown" && location.path === main,
    ),
  );
  await put(
    "tests/pair-rejection.test.mjs",
    `import assert from "node:assert/strict";
import test from "node:test";
import { parsePair } from "../${main}";
test("parsePair admits only two finite numbers", () => {
  assert.deepEqual(parsePair([1, 2]), [1, 2]);
  for (const malformed of [[1], [1, 2, 3], [1, "2"], ["1", 2], [1, NaN], null]) {
    assert.throws(() => parsePair(malformed), TypeError);
  }
});
`,
  );
  await runCommand(process.execPath, ["--test", "tests/pair-rejection.test.mjs"], physicalConsumer);
  const expression = "value as unknown as readonly [number, number]";
  const start = parser.indexOf(expression);
  assert.ok(start >= 0);
  await put("bridges.json", {
    schemaVersion: 1,
    bridges: [
      {
        path: main,
        start,
        end: start + expression.length,
        sha256: createHash("sha256").update(expression).digest("hex"),
        rationale:
          "The parser checks exact length and finite numeric element types before this tuple assertion.",
        rejectingTest: "tests/pair-rejection.test.mjs",
      },
    ],
  });
  await put("quality.yaml", { ...quality, schemaVersion: 5, bridgeAdmissionsPath: "bridges.json" });
  assert.equal((await invoke(0)).outcome, "passed");
}
