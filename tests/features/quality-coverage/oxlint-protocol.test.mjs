import assert from "node:assert/strict";
import test from "node:test";
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

test("compiler errors and malformed project output cannot become valid type context", async () => {
  assert.deepEqual(await createOxlintSession(input, { run: async () => result(`${input.consumerRoot}/${source}\n${input.consumerRoot}/node_modules/typescript/lib/lib.d.ts\n`) }).typeContext(), [source]);
  for (const output of [result("error TS2307: missing dependency", 2), result("relative/file.ts\n"), result("")]) {
    await assert.rejects(createOxlintSession(input, { run: async () => output }).typeContext(), /evidence/u);
  }
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
