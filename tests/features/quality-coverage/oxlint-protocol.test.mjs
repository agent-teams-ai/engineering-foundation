import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createOxlintSession } from "../../../packages/engineering-foundation/dist/features/quality-coverage/node.js";

const source = "packages/contexts/private/src/main.ts";
const input = {
  consumerRoot: "/disposable consumer", nodeExecutable: "/node",
  oxlintEntrypoint: "/disposable consumer/node_modules/oxlint/bin/oxlint",
  compilerEntrypoint: "/disposable consumer/node_modules/typescript/bin/tsc",
  configPath: "lint.json", sourceRoots: ["packages"], projects: ["tsconfig.json"]
};
const envelope = (diagnostics = []) => JSON.stringify({ diagnostics, number_of_files: 1 });
const finding = { code: "typescript(no-floating-promises)", filename: source, severity: "error" };
const result = (stdout, exitCode = 0, stderr = "") => ({ stdout, exitCode, stderr, signal: null });

async function compilerFixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), "quality compiler alias "));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(await realpath(temporary), "consumer");
  await mkdir(join(root, dirname(source)), { recursive: true });
  await writeFile(join(root, source), "export const value = 1;\n");
  const declarations = [`${dirname(source)}/owned.d.ts`, `${dirname(source)}/owned.d.mts`];
  for (const declaration of declarations) {
    await writeFile(join(root, declaration), "export declare const owned: number;\n");
  }
  const alias = join(temporary, "alias");
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  return { root, alias, declarations };
}

test("real compiler evidence matches selected sources across consumer root aliases", async (t) => {
  const { root, alias, declarations } = await compilerFixture(t);
  const require = createRequire(import.meta.url);
  const compilerEntrypoint = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
  const oxlintEntrypoint = join(dirname(require.resolve("oxlint/package.json")), "bin/oxlint");
  await writeFile(join(root, "lint.json"), "{}\n");
  for (const [consumerRoot, evidenceRoot] of [[alias, root], [root, alias]]) {
    await t.test(consumerRoot === alias ? "aliased consumer root" : "aliased compiler paths", async () => {
      await writeFile(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { strict: true, types: [], noEmit: true },
        files: [join(evidenceRoot, source), ...declarations.map((declaration) => join(evidenceRoot, declaration))]
      }));
      const executor = { run: async ({ command, args, cwd }) => {
        const output = await promisify(execFile)(command, args, { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 });
        if (args.includes("--listFiles")) {
          assert.ok(output.stdout.replaceAll("\\", "/").includes(join(evidenceRoot, source).replaceAll("\\", "/")),
            "real compiler preserves the configured root spelling");
        }
        return result(output.stdout, 0, output.stderr);
      } };
      const session = createOxlintSession({ ...input, consumerRoot, nodeExecutable: process.execPath,
        compilerEntrypoint, oxlintEntrypoint }, executor);
      const selected = await session.select();
      assert.deepEqual(selected, [source, ...declarations].toSorted());
      const context = await session.typeContext();
      assert.deepEqual(context, selected);
    });
  }
});

test("selection and typed execution share consumer cwd, config, roots and protective flags", async () => {
  const requests = [];
  const executor = { run: async (request) => {
    requests.push(request);
    return request.args.includes("--debug") ? result(`${source}\n`) : result(envelope([finding]), 1);
  } };
  const session = createOxlintSession(input, executor);
  assert.deepEqual(await session.select(), [source]);
  const { diagnostics } = await session.lint();
  assert.equal(diagnostics[0].location.path, source);
  assert.deepEqual(diagnostics[0].evidence.at(-1), { kind: "tool-rule", value: finding.code });
  for (const request of requests) {
    assert.equal(request.cwd, input.consumerRoot);
    assert.equal(request.command, input.nodeExecutable);
    assert.equal(request.strictUtf8, true);
    assert.equal(request.timeoutMs, 120_000);
    assert.ok(request.args.includes("--no-ignore"));
    assert.ok(request.args.includes("--disable-nested-config"));
    assert.deepEqual(request.args.slice(-1), input.sourceRoots);
  }
  assert.deepEqual(requests[0].args.filter((value) => value !== "--debug" && value !== "files"), requests[1].args);
});

test("good lint counterpart passes while empty or contradictory execution evidence rejects", async () => {
  const session = createOxlintSession(input, { run: async () => result(envelope()) });
  assert.deepEqual(await session.lint(), { files: 1, diagnostics: [] });
  for (const output of [
    result("not JSON", 1), result(envelope(), 1), result(envelope([finding]), 0),
    result(JSON.stringify({ diagnostics: [], number_of_files: 0 })),
    result(envelope([{ ...finding, code: undefined }]), 1),
    result(envelope([{ ...finding, filename: "../escaped.ts" }]), 1),
    result(envelope(), 0, "Failed to find tsgolint executable"),
    { ...result(envelope()), signal: "SIGTERM" }
  ]) {
    await assert.rejects(createOxlintSession(input, { run: async () => output }).lint(), /evidence/u);
  }
});

test("selection accepts Windows separators but rejects malformed, duplicate and empty output", async () => {
  assert.deepEqual(await createOxlintSession(input, { run: async () => result(`${source.replaceAll("/", "\\")}\r\n`) }).select(), [source]);
  for (const output of ["", `${source}\n${source}\n`, "/absolute.ts\n", "../escaped.ts\n", `${source}\n\n`]) {
    await assert.rejects(createOxlintSession(input, { run: async () => result(output) }).select(), /malformed/u);
  }
});

test("compiler errors and malformed project output cannot become valid type context", async (t) => {
  const { root } = await compilerFixture(t);
  const sessionInput = { ...input, consumerRoot: root };
  const dependency = join(root, "node_modules/typescript/lib/lib.d.ts");
  await mkdir(dirname(dependency), { recursive: true });
  await writeFile(dependency, "export {};\n");
  assert.deepEqual(await createOxlintSession(sessionInput, { run: async () => result(`${join(root, source)}\n${dependency}\n`) }).typeContext(), [source]);
  for (const output of [result("error TS2307: missing dependency", 2), result("relative/file.ts\n"), result("")]) {
    await assert.rejects(createOxlintSession(sessionInput, { run: async () => output }).typeContext(), /evidence/u);
  }
  await assert.rejects(createOxlintSession(sessionInput, {
    run: async () => result(`${join(root, "missing.ts")}\n`)
  }).typeContext(), { code: "ENOENT" });
  const outside = join(dirname(root), "outside.d.ts");
  await writeFile(outside, "export {};\n");
  const escaped = join(root, "escaped.d.ts");
  await symlink(outside, escaped);
  assert.deepEqual(await createOxlintSession(sessionInput, {
    run: async () => result(`${join(root, source)}\n${outside}\n${escaped}\n`)
  }).typeContext(), [source]);
});

test("executor failures and cancellation retain their identity and signal", async () => {
  const controller = new AbortController();
  const failure = new Error("executor deadline");
  const session = createOxlintSession(input, { run: async (request) => {
    assert.equal(request.signal, controller.signal);
    throw failure;
  } });
  await assert.rejects(session.select(controller.signal), (error) => error === failure);
});

test("empty explicit targets fail closed without invoking Oxlint", async () => {
  let invoked = false;
  const session = createOxlintSession({ ...input, sourceRoots: [] }, { run: async () => { invoked = true; return result(envelope()); } });
  await assert.rejects(session.select(), /no explicit source targets/u);
  await assert.rejects(session.lint(), /no explicit source targets/u);
  assert.equal(invoked, false);
});
