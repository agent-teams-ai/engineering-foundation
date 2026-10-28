import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  resolveCompilerExecutable,
  resolveToolExecutable,
  resolveExecutables,
  resolveDoctorExecutable,
  resolveExperimentalBunLintExecutable,
} from "../dist/features/toolchain-execution/adapters/executables.js";

void test("experimental lint refuses an unpinned or production Bun alias before executable lookup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "TEST-bun-lint-declaration-"));
  try {
    for (const manifest of [
      {},
      { devDependencies: { "bun-lint": "npm:bun@canary" } },
      { dependencies: { "bun-lint": "npm:bun@1.4.4-canary.20261028.1" } },
      {
        devDependencies: { "bun-lint": "npm:bun@1.4.4-canary.20261028.1" },
        optionalDependencies: { "bun-lint": "npm:bun@1.4.4-canary.20261028.1" },
      },
      {
        devDependencies: { "bun-lint": "npm:bun@1.4.4-canary.20261028.1" },
        peerDependencies: { "bun-lint": "npm:bun@1.4.4-canary.20261028.1" },
      },
      {
        devDependencies: { "bun-lint": "npm:bun@1.4.4-canary.20261028.1" },
        bundledDependencies: ["bun-lint"],
      },
    ]) {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
      assert.throws(
        () => resolveExperimentalBunLintExecutable(root),
        /TOOLCHAIN_BUN_LINT_DECLARATION/u,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("experimental lint binds both archive manifests and refuses an escaped native binary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "TEST-bun-lint-installation-"));
  try {
    const platform = process.platform === "win32" ? "windows" : process.platform;
    const arch = process.arch === "arm64" ? "aarch64" : process.arch;
    const musl =
      process.platform === "linux" &&
      !(process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header
        .glibcVersionRuntime;
    const name = `@oven/bun-${platform}-${arch}${musl ? "-musl" : ""}`;
    const wrapper = path.join(root, "node_modules/bun-lint");
    const native = path.join(root, "node_modules", name);
    const version = "1.4.4-canary.20261028.1+11c3671";
    fs.mkdirSync(wrapper, { recursive: true });
    fs.mkdirSync(path.join(native, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        devDependencies: { "bun-lint": "npm:bun@1.4.4-canary.20261028.1" },
      }),
    );
    fs.writeFileSync(
      path.join(wrapper, "package.json"),
      JSON.stringify({
        name: "bun",
        version,
        optionalDependencies: { [name]: version },
      }),
    );
    fs.writeFileSync(path.join(native, "package.json"), JSON.stringify({ name, version }));
    const binary = path.join(native, "bin", process.platform === "win32" ? "bun.exe" : "bun");
    fs.writeFileSync(binary, "not executed", { mode: 0o755 });
    assert.equal(resolveExperimentalBunLintExecutable(root).command, fs.realpathSync(binary));
    fs.writeFileSync(path.join(native, "package.json"), JSON.stringify({ name, version: "1.4.4" }));
    assert.throws(
      () => resolveExperimentalBunLintExecutable(root),
      /TOOLCHAIN_BUN_LINT_NATIVE_PIN_MISMATCH/u,
    );
    fs.writeFileSync(path.join(native, "package.json"), JSON.stringify({ name, version }));
    fs.rmSync(binary);
    const outside = path.join(root, "outside");
    fs.writeFileSync(outside, "not executed", { mode: 0o755 });
    fs.symlinkSync(outside, binary);
    assert.throws(
      () => resolveExperimentalBunLintExecutable(root),
      /TOOLCHAIN_DEPENDENCY_OUTSIDE_INSTALLATION/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("compiler resolves qualified native tsc directly", () => {
  const executable = resolveCompilerExecutable();
  assert.match(executable.command, /[/\\]lib[/\\]tsc(?:\.exe)?$/u);
  assert.deepEqual(executable.prefix, []);
});

function physicalFixture(
  tool: "typescript" | "tsrs" | "oxlint" | "oxlint-tsgolint",
  sourceDevelopment = false,
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "TEST-toolchain-files-"));
  const consumer = path.join(directory, "consumer");
  const root = sourceDevelopment
    ? path.join(directory, "source-stack-toolchain")
    : path.join(consumer, "node_modules/stack-toolchain");
  const modules = sourceDevelopment
    ? path.join(root, "node_modules")
    : path.join(consumer, "node_modules");
  const pins = JSON.parse(
    fs.readFileSync(new URL("../toolchain-manifest.json", import.meta.url), "utf8"),
  ) as Record<string, string>;
  const libc =
    process.platform === "linux"
      ? (process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header
          .glibcVersionRuntime !== undefined
        ? "-gnu"
        : "-musl"
      : "";
  const nativeName =
    tool === "typescript"
      ? `@typescript/typescript-${process.platform}-${process.arch}`
      : tool === "tsrs"
        ? `@tsrs/${process.platform}-${process.arch}${libc}`
        : tool === "oxlint"
          ? `@oxlint/binding-${process.platform}-${process.arch}${libc || (process.platform === "win32" ? "-msvc" : "")}`
          : `@oxlint-tsgolint/${process.platform}-${process.arch}`;
  const wrapper = path.join(modules, tool);
  const native = path.join(modules, nativeName);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(wrapper, { recursive: true });
  fs.mkdirSync(native, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "stack-toolchain", dependencies: { [tool]: pins[tool] } }),
  );
  fs.writeFileSync(
    path.join(wrapper, "package.json"),
    JSON.stringify({ version: pins[tool], optionalDependencies: { [nativeName]: pins[tool] } }),
  );
  fs.writeFileSync(path.join(native, "package.json"), JSON.stringify({ version: pins[tool] }));
  const binary =
    tool === "typescript"
      ? path.join(native, "lib", process.platform === "win32" ? "tsc.exe" : "tsc")
      : tool === "tsrs"
        ? path.join(native, process.platform === "win32" ? "tsrs.exe" : "tsrs")
        : tool === "oxlint"
          ? path.join(
              native,
              `oxlint.${process.platform}-${process.arch}${libc || (process.platform === "win32" ? "-msvc" : "")}.node`,
            )
          : path.join(native, process.platform === "win32" ? "tsgolint.exe" : "tsgolint");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "never executed", { mode: 0o755 });
  const entry = path.join(wrapper, "bin", tool);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, "never executed", { mode: 0o755 });
  const outside = path.join(directory, "outside", "payload");
  fs.mkdirSync(path.dirname(outside));
  fs.writeFileSync(outside, "never executed", { mode: 0o755 });
  return { directory, root, modules, binary, entry, outside };
}

void test("final tool files cannot escape an installed dependency boundary through symlinks", () => {
  const cases = [
    { tool: "typescript", entry: false },
    { tool: "tsrs", entry: false },
    { tool: "oxlint-tsgolint", entry: false },
    { tool: "oxlint", entry: false },
    { tool: "oxlint", entry: true },
  ] as const;
  for (const subject of cases) {
    const f = physicalFixture(subject.tool);
    try {
      const filename = subject.entry ? f.entry : f.binary;
      fs.unlinkSync(filename);
      fs.symlinkSync(f.outside, filename, "file");
      assert.throws(
        () => resolveDoctorExecutable(subject.tool, f.root),
        /TOOLCHAIN_DEPENDENCY_OUTSIDE_INSTALLATION/u,
        `${subject.tool}:${subject.entry ? "wrapper" : "native"}`,
      );
    } finally {
      fs.rmSync(f.directory, { recursive: true, force: true });
    }
  }
});

void test("contained pnpm and Bun store paths with hardlinked files remain admitted", () => {
  for (const store of [".pnpm", ".bun"]) {
    const f = physicalFixture("oxlint-tsgolint");
    try {
      const retained = path.join(f.modules, store, "fixture", "native");
      fs.mkdirSync(path.dirname(retained), { recursive: true });
      fs.linkSync(f.outside, retained);
      fs.unlinkSync(f.binary);
      fs.symlinkSync(retained, f.binary, "file");
      assert.equal(
        resolveDoctorExecutable("oxlint-tsgolint", f.root)?.command,
        fs.realpathSync(retained),
      );
    } finally {
      fs.rmSync(f.directory, { recursive: true, force: true });
    }
  }
});

void test("explicit source-development resolution retains its existing external file layout", () => {
  const f = physicalFixture("oxlint-tsgolint", true);
  try {
    fs.unlinkSync(f.binary);
    fs.symlinkSync(f.outside, f.binary, "file");
    assert.equal(
      resolveDoctorExecutable("oxlint-tsgolint", f.root)?.command,
      fs.realpathSync(f.outside),
    );
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
void test("missing required compiler rejects without PATH fallback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "TEST-toolchain-executable-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    assert.throws(() => resolveCompilerExecutable(root), /TOOLCHAIN_REQUIRED_COMPILER_MISSING/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
void test("installed wrong compiler pin is terminal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "TEST-toolchain-executable-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    const directory = path.join(root, "node_modules", "typescript");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "typescript", version: "1.0.0" }),
    );
    assert.throws(() => resolveCompilerExecutable(root), /TOOLCHAIN_PIN_MISMATCH/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("dependency wrapper cannot escape the installation to its exact parent", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "TEST-toolchain-parent-"));
  const consumer = path.join(directory, "consumer");
  const root = path.join(consumer, "node_modules/stack-toolchain");
  const pins = JSON.parse(
    fs.readFileSync(new URL("../toolchain-manifest.json", import.meta.url), "utf8"),
  ) as Record<string, string>;
  const nativeName = `@typescript/typescript-${process.platform}-${process.arch}`;
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "stack-toolchain",
        dependencies: { typescript: pins["typescript"] },
      }),
    );
    fs.writeFileSync(
      path.join(consumer, "package.json"),
      JSON.stringify({
        name: "typescript",
        version: pins["typescript"],
        optionalDependencies: { [nativeName]: pins["typescript"] },
      }),
    );
    const native = path.join(consumer, "node_modules", nativeName);
    fs.mkdirSync(path.join(native, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(native, "package.json"),
      JSON.stringify({ version: pins["typescript"] }),
    );
    fs.writeFileSync(
      path.join(native, "lib", process.platform === "win32" ? "tsc.exe" : "tsc"),
      "never executed",
      { mode: 0o755 },
    );
    fs.symlinkSync(consumer, path.join(consumer, "node_modules/typescript"), "junction");
    assert.throws(
      () => resolveCompilerExecutable(root),
      /TOOLCHAIN_DEPENDENCY_OUTSIDE_INSTALLATION/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

void test("installed qualified checker and NAPI routes resolve to existing files", () => {
  const engines = resolveExecutables();
  if (process.platform === "linux" || (process.platform === "darwin" && process.arch === "arm64")) {
    assert.ok(engines.tsrs);
  }
  assert.ok(engines.bun);
  for (const executable of Object.values(engines)) {
    if (executable === null) {
      continue;
    }
    assert.ok(fs.statSync(executable.command).isFile());
  }
  for (const tool of ["oxlint", "oxfmt"] as const) {
    const executable = resolveToolExecutable(tool);
    assert.equal(executable.command, process.execPath);
    assert.ok(fs.statSync(executable.prefix[0]!).isFile());
  }
});

void test(
  "non-executable optional checker is unavailable while compiler remains mandatory",
  { skip: process.platform === "win32" },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "TEST-toolchain-permission-"));
    const pins = JSON.parse(
      fs.readFileSync(new URL("../toolchain-manifest.json", import.meta.url), "utf8"),
    ) as Record<string, string>;
    try {
      fs.writeFileSync(path.join(root, "package.json"), "{}");
      const libc =
        process.platform === "linux"
          ? (process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header
              .glibcVersionRuntime !== undefined
            ? "-gnu"
            : "-musl"
          : "";
      const nativeName = `@tsrs/${process.platform}-${process.arch}${libc}`;
      const wrapper = path.join(root, "node_modules", "tsrs");
      const native = path.join(root, "node_modules", nativeName);
      fs.mkdirSync(wrapper, { recursive: true });
      fs.mkdirSync(native, { recursive: true });
      fs.writeFileSync(
        path.join(wrapper, "package.json"),
        JSON.stringify({
          version: pins["tsrs"],
          optionalDependencies: { [nativeName]: pins["tsrs"] },
        }),
      );
      fs.writeFileSync(
        path.join(native, "package.json"),
        JSON.stringify({ version: pins["tsrs"] }),
      );
      fs.writeFileSync(path.join(native, "tsrs"), "not executable", { mode: 0o644 });
      const compiler = path.join(root, "node_modules", "typescript");
      const compilerName = `@typescript/typescript-${process.platform}-${process.arch}`;
      const compilerNative = path.join(root, "node_modules", compilerName);
      fs.mkdirSync(compiler, { recursive: true });
      fs.mkdirSync(path.join(compilerNative, "lib"), { recursive: true });
      fs.writeFileSync(
        path.join(compiler, "package.json"),
        JSON.stringify({
          version: pins["typescript"],
          optionalDependencies: { [compilerName]: pins["typescript"] },
        }),
      );
      fs.writeFileSync(
        path.join(compilerNative, "package.json"),
        JSON.stringify({ version: pins["typescript"] }),
      );
      const binary = path.join(compilerNative, "lib", "tsc");
      fs.writeFileSync(binary, "compiler", { mode: 0o755 });
      const bunName = `@oven/bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "aarch64" : process.arch}${libc === "-musl" ? "-musl" : ""}`;
      const bunWrapper = path.join(root, "node_modules", "bun");
      const bunNative = path.join(root, "node_modules", bunName);
      fs.mkdirSync(bunWrapper, { recursive: true });
      fs.mkdirSync(bunNative, { recursive: true });
      fs.writeFileSync(
        path.join(bunWrapper, "package.json"),
        JSON.stringify({ version: pins["bun"], optionalDependencies: { [bunName]: pins["bun"] } }),
      );
      fs.writeFileSync(
        path.join(bunNative, "package.json"),
        JSON.stringify({ version: pins["bun"] }),
      );
      assert.equal(resolveExecutables(root).bun, null);
      fs.writeFileSync(path.join(bunNative, "bin"), "invalid parent");
      assert.throws(() => resolveExecutables(root), { code: "ENOTDIR" });
      fs.rmSync(path.join(bunNative, "bin"));
      assert.equal(resolveExecutables(root).tsrs, null);
      fs.rmSync(path.join(native, "tsrs"));
      assert.equal(resolveExecutables(root).tsrs, null);
      fs.writeFileSync(path.join(bunNative, "package.json"), JSON.stringify({ version: "0.0.0" }));
      assert.throws(() => resolveExecutables(root), /TOOLCHAIN_NATIVE_PIN_MISMATCH:bun/u);
      fs.writeFileSync(
        path.join(bunNative, "package.json"),
        JSON.stringify({ version: pins["bun"] }),
      );
      fs.writeFileSync(path.join(native, "tsrs"), "not executable", { mode: 0o644 });
      assert.equal(fs.statSync(path.join(native, "tsrs")).mode & 0o777, 0o644);
      fs.chmodSync(binary, 0o644);
      assert.throws(() => resolveCompilerExecutable(root), { code: "EACCES" });
      fs.rmSync(binary);
      assert.throws(
        () => resolveCompilerExecutable(root),
        /TOOLCHAIN_NATIVE_BINARY_MISSING:typescript/u,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
