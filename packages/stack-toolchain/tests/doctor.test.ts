import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installedDependency } from "./installed-dependency.ts";
import type { DoctorDetails } from "../src/features/toolchain-execution/adapters/doctor.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const pins = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "toolchain-manifest.json"), "utf8"),
) as Record<string, string>;
interface Report {
  readonly schemaVersion: number;
  readonly status: string;
  readonly exitCode: number;
  readonly details: DoctorDetails;
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "TEST-toolchain-doctor-"));
  const tool = path.join(directory, "tool");
  const consumer = path.join(directory, "consumer");
  fs.mkdirSync(path.join(tool, "node_modules"), { recursive: true });
  fs.mkdirSync(consumer);
  for (const name of ["dist", "presets", "toolchain-manifest.json"]) {
    fs.cpSync(path.join(packageRoot, name), path.join(tool, name), { recursive: true });
  }
  const version = "0.0.0-doctor-fixture";
  fs.writeFileSync(
    path.join(tool, "package.json"),
    JSON.stringify({
      name: "stack-toolchain",
      version,
      type: "module",
      dependencies: Object.fromEntries(
        Object.entries(pins).filter(([name]) => name !== "schemaVersion"),
      ),
    }),
  );
  // Optional checkers are intentionally absent. All executable probes still run
  // through the built CLI and its real process adapter, without PATH fallback.
  for (const name of [
    "node-or-bun",
    "jsonc-parser",
    "typescript",
    "oxlint",
    "oxlint-tsgolint",
    "oxfmt",
  ]) {
    fs.symlinkSync(installedDependency(name), path.join(tool, "node_modules", name), "junction");
  }
  const run = (command = "doctor") =>
    spawnSync(process.execPath, [path.join(tool, "dist/cli.js"), command, "--json"], {
      cwd: consumer,
      encoding: "utf8",
      timeout: 30_000,
    });
  const doctor = () => {
    const result = run();
    assert.equal(result.error, undefined);
    assert.equal(result.stderr, "");
    return { result, report: JSON.parse(result.stdout) as Report };
  };
  return { directory, tool, consumer, version, run, doctor };
}

void test("doctor reports actual package/all tool versions and accepts optional absence without changing fallback", () => {
  const f = fixture();
  try {
    const { result, report } = f.doctor();
    assert.equal(result.status, 0);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.details.schemaVersion, 1);
    assert.equal(report.details.packageVersion, f.version);
    assert.equal(report.status, "passed");
    assert.deepEqual(report.details.findings, [
      { tool: "tsrs", code: "TOOLCHAIN_OPTIONAL_TOOL_UNAVAILABLE", severity: "info" },
      { tool: "bun", code: "TOOLCHAIN_OPTIONAL_TOOL_UNAVAILABLE", severity: "info" },
    ]);
    for (const name of ["typescript", "oxlint", "oxlint-tsgolint", "oxfmt"] as const) {
      assert.equal(report.details[name].available, true);
      assert.equal(report.details[name].required, true);
      assert.equal(report.details[name].installedVersion, pins[name]);
      assert.equal(report.details[name].resolvedVersion, pins[name]);
    }
    assert.equal(report.details["oxlint-tsgolint"].versionSource, "installed-package");
    assert.equal(report.details.typescript.versionSource, "binary-output");
    assert.equal(report.details.tsrs.available, false);
    assert.equal(report.details.bun.available, false);
    fs.writeFileSync(path.join(f.consumer, "index.ts"), "export const answer: number = 42;\n");
    fs.writeFileSync(
      path.join(f.consumer, "tsconfig.json"),
      '{"compilerOptions":{"strict":true,"noEmit":true},"files":["index.ts"]}',
    );
    fs.writeFileSync(path.join(f.consumer, "lint.json"), "{}");
    fs.writeFileSync(
      path.join(f.consumer, "toolchain.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        profile: "typescript-node",
        typecheck: { projects: ["tsconfig.json"] },
        lint: { config: "lint.json", paths: ["index.ts"] },
        format: { paths: ["index.ts"] },
      }),
    );
    const checked = f.run("typecheck");
    assert.equal(checked.status, 0, checked.stdout);
    const observed = JSON.parse(checked.stdout) as {
      status: string;
      details: { engine: string; attempts: { engine: string }[] };
    };
    assert.equal(observed.status, "passed-with-fallback");
    assert.equal(observed.details.engine, "typescript");
    assert.deepEqual(
      observed.details.attempts.map((attempt) => attempt.engine),
      ["tsrs", "bun", "typescript"],
    );
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

void test("doctor rejects a missing required formatter with a stable per-tool finding", () => {
  const f = fixture();
  try {
    fs.rmSync(path.join(f.tool, "node_modules/oxfmt"), { recursive: true, force: true });
    const { result, report } = f.doctor();
    assert.equal(result.status, 2);
    assert.equal(report.status, "failed");
    assert.equal(report.details.oxfmt.available, false);
    assert.equal(report.details.oxfmt.installedVersion, null);
    assert.ok(
      report.details.findings.some(
        (finding) =>
          finding.tool === "oxfmt" &&
          finding.code === "TOOLCHAIN_TOOL_UNAVAILABLE" &&
          finding.severity === "error",
      ),
    );
    assert.equal(report.details.typescript.available, true);
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

void test("doctor preserves installed wrong-pin evidence before resolver refusal", () => {
  const f = fixture();
  try {
    const wrapper = path.join(f.tool, "node_modules/oxlint");
    fs.rmSync(wrapper, { recursive: true, force: true });
    fs.mkdirSync(wrapper);
    fs.writeFileSync(path.join(wrapper, "package.json"), '{"name":"oxlint","version":"99.0.0"}');
    const { result, report } = f.doctor();
    assert.equal(result.status, 2);
    assert.equal(report.details.oxlint.available, false);
    assert.equal(report.details.oxlint.installedVersion, "99.0.0");
    assert.equal(report.details.oxlint.resolutionCode, "TOOLCHAIN_PIN_MISMATCH:oxlint");
    assert.ok(
      report.details.findings.some(
        (finding) => finding.tool === "oxlint" && finding.code === "TOOLCHAIN_TOOL_PIN_MISMATCH",
      ),
    );
    assert.equal(report.details.oxfmt.available, true);
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

void test("doctor distinguishes a wrong native companion pin from ordinary unavailability", () => {
  const f = fixture();
  try {
    const wrapper = path.join(f.tool, "node_modules/oxlint-tsgolint");
    const nativeName = `@oxlint-tsgolint/${process.platform}-${process.arch}`;
    fs.rmSync(wrapper, { recursive: true, force: true });
    fs.mkdirSync(wrapper);
    fs.writeFileSync(
      path.join(wrapper, "package.json"),
      JSON.stringify({
        name: "oxlint-tsgolint",
        version: pins["oxlint-tsgolint"],
        optionalDependencies: { [nativeName]: pins["oxlint-tsgolint"] },
      }),
    );
    const native = path.join(f.tool, "node_modules", nativeName);
    fs.mkdirSync(native, { recursive: true });
    fs.writeFileSync(path.join(native, "package.json"), '{"version":"99.0.0"}');
    const { result, report } = f.doctor();
    assert.equal(result.status, 2);
    assert.equal(report.details["oxlint-tsgolint"].installedVersion, pins["oxlint-tsgolint"]);
    assert.equal(
      report.details["oxlint-tsgolint"].resolutionCode,
      "TOOLCHAIN_TSGOLINT_NATIVE_PIN_MISMATCH",
    );
    assert.ok(
      report.details.findings.some(
        (finding) =>
          finding.tool === "oxlint-tsgolint" && finding.code === "TOOLCHAIN_TOOL_PIN_MISMATCH",
      ),
    );
    fs.writeFileSync(
      path.join(native, "package.json"),
      JSON.stringify({ version: pins["oxlint-tsgolint"] }),
    );
    fs.mkdirSync(path.join(native, process.platform === "win32" ? "tsgolint.exe" : "tsgolint"));
    const directory = f.doctor();
    assert.equal(directory.result.status, 2);
    assert.equal(directory.report.details["oxlint-tsgolint"].available, false);
    assert.equal(
      directory.report.details["oxlint-tsgolint"].resolutionCode,
      "TOOLCHAIN_NATIVE_BINARY_INVALID:oxlint-tsgolint",
    );
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
