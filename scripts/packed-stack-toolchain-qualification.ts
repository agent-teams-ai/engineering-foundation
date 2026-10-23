import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runCommand } from "./pack-test-support.mjs";

function doctorRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Packed CI binds the diagnostic to its installed package's public metadata. */
export function validateInstalledDoctorReport(
  value: unknown,
  installedPackage: unknown,
  manifest: unknown,
): void {
  const report = doctorRecord(value),
    pins = doctorRecord(manifest),
    packageJson = doctorRecord(installedPackage);
  const dependencies = doctorRecord(packageJson["dependencies"]);
  const optionalDependencies = doctorRecord(packageJson["optionalDependencies"]);
  assert.equal(pins["schemaVersion"], 1);
  assert.equal(report["schemaVersion"], 1);
  assert.equal(report["command"], "doctor");
  assert.equal(report["status"], "passed");
  assert.equal(report["exitCode"], 0);
  assert.equal(typeof report["durationMs"], "number");
  assert.ok(Number.isFinite(report["durationMs"]) && Number(report["durationMs"]) >= 0);
  assert.deepEqual(report["versions"], pins);
  const details = doctorRecord(report["details"]);
  assert.equal(details["schemaVersion"], 1);
  assert.equal(packageJson["name"], "stack-toolchain");
  assert.equal(typeof packageJson["version"], "string");
  assert.equal(details["packageVersion"], packageJson["version"]);
  assert.ok(Array.isArray(details["findings"]));
  const optionalMissing = new Set<string>();
  for (const item of details["findings"]) {
    const finding = doctorRecord(item);
    assert.deepEqual(Object.keys(finding).toSorted(), ["code", "severity", "tool"]);
    assert.equal(finding["code"], "TOOLCHAIN_OPTIONAL_TOOL_UNAVAILABLE");
    assert.equal(finding["severity"], "info");
    assert.equal(typeof finding["tool"], "string");
    const tool = String(finding["tool"]);
    assert.equal(typeof pins[tool], "string");
    assert.ok(!optionalMissing.has(tool));
    optionalMissing.add(tool);
  }
  for (const [tool, expected] of Object.entries(pins)) {
    if (tool === "schemaVersion") {
      continue;
    }
    assert.equal(typeof expected, "string");
    const observation = doctorRecord(details[tool]);
    assert.equal(observation["expectedVersion"], expected);
    const required = Object.hasOwn(dependencies, tool);
    assert.notEqual(required, Object.hasOwn(optionalDependencies, tool));
    assert.equal(required ? dependencies[tool] : optionalDependencies[tool], expected);
    assert.equal(observation["required"], required);
    assert.equal(typeof observation["available"], "boolean");
    assert.ok(
      observation["installedVersion"] === null || observation["installedVersion"] === expected,
    );
    if (observation["available"]) {
      assert.equal(observation["resolvedVersion"], expected);
      assert.ok(
        ["binary-output", "installed-package"].includes(String(observation["versionSource"])),
      );
      assert.ok(!optionalMissing.has(tool));
    } else {
      assert.equal(observation["required"], false);
      assert.equal(observation["resolvedVersion"], null);
      assert.equal(observation["versionSource"], null);
      assert.ok(optionalMissing.has(tool));
    }
  }
}

/** Runs only against an installed candidate in a disposable package consumer. */
export async function qualifyInstalledStackToolchain(consumerRoot: string): Promise<void> {
  const root = join(consumerRoot, "TEST-stack-toolchain");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ private: true, type: "module", scripts: { check: "exit 99" } }),
  );
  await writeFile(join(root, "index.ts"), 'export const value: string = "ready";\n');
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      files: ["index.ts"],
      compilerOptions: { strict: true, skipLibCheck: true, outDir: "dist" },
    }),
  );
  await writeFile(join(root, ".oxlintrc.json"), "{}");
  await writeFile(
    join(root, "toolchain.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      profile: "typescript-node",
      typecheck: { projects: ["tsconfig.json"] },
      lint: { config: ".oxlintrc.json", paths: ["index.ts"] },
      format: { paths: ["index.ts"] },
    }),
  );
  await writeFile(
    join(root, "oxfmt.config.ts"),
    'import fs from "node:fs"; fs.writeFileSync("formatter-marker", "executed"); export default {};',
  );
  const cli = join(consumerRoot, "node_modules/stack-toolchain/dist/cli.js");
  const installed = createRequire(join(consumerRoot, "package.json"));
  const packageJson = doctorRecord(
    JSON.parse(await readFile(installed.resolve("stack-toolchain/package.json"), "utf8")),
  );
  assert.equal(packageJson["name"], "stack-toolchain");
  const manifest: unknown = JSON.parse(
    await readFile(installed.resolve("stack-toolchain/toolchain-manifest.json"), "utf8"),
  );
  const doctor = await runCommand(process.execPath, [cli, "doctor", "--json"], root);
  validateInstalledDoctorReport(JSON.parse(doctor.stdout), packageJson, manifest);
  for (const command of ["typecheck", "lint", "format:check"]) {
    const result = await runCommand(process.execPath, [cli, command, "--json"], root);
    assert.equal(JSON.parse(result.stdout).exitCode, 0, command);
  }
  await runCommand(
    process.execPath,
    [cli, "compile", "--json", "--project", "tsconfig.json"],
    root,
  );
  assert.match(await readFile(join(root, "dist/index.js"), "utf8"), /ready/u);
  await assert.rejects(readFile(join(root, "formatter-marker")), /ENOENT/u);
  const original = await readFile(join(root, "index.ts"), "utf8");
  await writeFile(join(root, "index.ts"), "export const value: string = 12;\n");
  let output = "";
  try {
    await runCommand(process.execPath, [cli, "typecheck", "--json"], root);
  } catch (error) {
    output = String((error as { stdout?: string }).stdout);
  }
  assert.match(output, /TS2322/u);
  await writeFile(join(root, "index.ts"), 'export const value:string="ready"');
  let formattingFailed = false;
  try {
    await runCommand(process.execPath, [cli, "format:check", "--json"], root);
  } catch {
    formattingFailed = true;
  }
  assert.equal(formattingFailed, true);
  assert.equal(await readFile(join(root, "index.ts"), "utf8"), 'export const value:string="ready"');
  await writeFile(join(root, "index.ts"), original);
}
