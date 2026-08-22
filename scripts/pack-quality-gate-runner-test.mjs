import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function testPackedQualityGateRunner({ consumerRoot, runPnpm }) {
  const manifestPath = join(consumerRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.scripts["gate:alpha"] = "node --eval \"process.stdout.write('alpha')\"";
  manifest.scripts["gate:omega"] = "node --eval \"process.stdout.write('omega')\"";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const foundationConfigPath = join(consumerRoot, "foundation.config.yaml");
  await writeFile(
    foundationConfigPath,
    `${await readFile(foundationConfigPath, "utf8")}  quality.gate-runner:\n    configPath: architecture/foundation/quality-gate-runner.yaml\n`,
    "utf8",
  );
  await writeFile(
    join(consumerRoot, "architecture", "foundation", "quality-gate-runner.yaml"),
    `schemaVersion: 1
packageManager: pnpm
profiles:
  - id: packed
    concurrency: 2
    tasks:
      - id: gate:alpha
      - id: gate:omega
        after: [gate:alpha]
`,
    "utf8",
  );

  const { stdout } = await runPnpm(
    [
      "--silent",
      "exec",
      "agent-teams-foundation",
      "gate",
      "run",
      "packed",
      "--consumer",
      consumerRoot,
      "--format",
      "json",
    ],
    consumerRoot,
  );
  const report = JSON.parse(stdout);
  if (
    report.reportSchemaVersion !== 1 ||
    report.outcome !== "passed" ||
    report.tasks?.map(({ id, outcome }) => `${id}:${outcome}`).join(",") !==
      "gate:alpha:passed,gate:omega:passed"
  ) {
    throw new Error("Packed quality gate runner did not execute its declared profile.");
  }
}
