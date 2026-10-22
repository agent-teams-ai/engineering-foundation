import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  resolveCompilerExecutable,
  resolveToolExecutable,
  resolveExecutables,
} from "../dist/features/toolchain-execution/adapters/executables.js";

void test("compiler resolves qualified native tsc directly", () => {
  const executable = resolveCompilerExecutable();
  assert.match(executable.command, /[/\\]lib[/\\]tsc(?:\.exe)?$/u);
  assert.deepEqual(executable.prefix, []);
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
