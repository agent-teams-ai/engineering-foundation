import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { CapabilityInputError, FoundationError, capabilityFailureReport, foundationReport, exitCodeForOutcome } from "../packages/engineering-foundation/dist/features/validation-reporting/api.js";
import { associateProcessFailureFacts, readProcessFailureFacts } from "../packages/engineering-foundation/dist/features/validation-reporting/process-failure-facts.js";
import { processFailure, processCleanupFailure } from "../packages/engineering-foundation/dist/process-execution/application/process-failure-policy.js";
import { ProcessCancellationError, ProcessTimeoutError } from "../packages/engineering-foundation/dist/process-execution/api.js";
import { NodeProcessRunner, executeManagedProcess } from "../packages/engineering-foundation/dist/process-execution/node-process-runner.js";
import { renderFoundationReportText } from "../packages/engineering-foundation/dist/features/foundation-check/adapters/inbound/cli/report-renderer.js";

const secret = "INJECTED_PROCESS_SECRET_path_query_token_env_stack";
const request = { command: secret, args: [secret], cwd: process.cwd() };
const schema = JSON.parse(await readFile(new URL("../packages/engineering-foundation/schemas/foundation-check-report/v1.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
function report(error: unknown) {
  const capability = capabilityFailureReport({ capabilityId: "fixture.process", capabilityConfigSchemaVersion: 1, error, phase: "execution" });
  const aggregate = foundationReport({ foundationVersion: "fixture", coverage: "full", capabilities: [capability] });
  assert.equal(validate(aggregate), true, JSON.stringify(validate.errors));
  assert.equal(capability.diagnostics.length, 0);
  assert.deepEqual(capability.summary, { errors: 0, warnings: 0, infos: 0 });
  for (const rendering of [JSON.stringify(capability), JSON.stringify(aggregate), renderFoundationReportText(aggregate)]) {
    assert.ok(!rendering.includes(secret), "complete report must omit injected secrets");
  }
  return { capability, aggregate };
}

// Regression: reporting collapses explicit producer observations or leaks an opaque cause.
test("finite producer reasons remain distinct in complete v1 reports", () => {
  const cause = new Error(secret, { cause: new Error(secret) });
  const cases: readonly [unknown, string][] = [
    [processFailure(request, secret, cause, { reason: "launch" }), "The process could not be started."],
    [processFailure(request, secret, cause, { reason: "exit", exitCode: 23, signal: "SIGTERM" }), "The process exited unsuccessfully. Observed exit code: 23. Observed signal: SIGTERM."],
    [new ProcessTimeoutError(500, { cause, requestDescription: secret }), "The process timed out. Timeout: 500ms."],
    [processFailure(request, secret, cause, { reason: "output-limit" }), "Process output exceeded the capture limit."],
    [processFailure(request, secret, cause, { reason: "invalid-output" }), "Process output was not valid UTF-8."],
    [processFailure(request, secret, cause, { reason: "stream" }), "A process output stream failed."],
    [processCleanupFailure(request, secret, cause, false), "Process cleanup failed."],
    [new FoundationError("PROCESS_FAILED", secret, { cause }), "An unexpected process failure occurred."]
  ];
  for (const [error, message] of cases) {
    assert.ok(error instanceof FoundationError);
    assert.equal(error.cause, cause);
    const { capability, aggregate } = report(error);
    assert.equal(capability.problem?.message, message);
    assert.equal(capability.problem?.code, "UNEXPECTED_PROCESS_FAILURE");
    assert.equal(capability.problem?.retryable, false);
    assert.equal(aggregate.outcome, "failed");
    assert.equal(exitCodeForOutcome(aggregate.outcome), 3);
  }
});

// Regression: structural copies/getters or bad numeric/signal values forge safe metadata.
test("facts require identity and bounded own data properties", () => {
  let getters = 0;
  const malformed: unknown[] = [
    { reason: secret }, { reason: "exit", exitCode: NaN },
    { reason: "exit", exitCode: Infinity }, { reason: "exit", exitCode: 1.5 },
    { reason: "exit", exitCode: -1 }, { reason: "exit", exitCode: 4_294_967_296 },
    { reason: "exit", signal: secret }, { reason: "launch", exitCode: 23 },
    { reason: "timeout", timeoutMs: 0 }, { reason: "timeout", timeoutMs: 2_147_483_648 },
    { reason: "timeout", timeoutMs: 1.5 }, { reason: "exit", cause: secret },
    { get reason() { getters++; throw new Error(secret); } },
    new Proxy({}, { ownKeys() { throw new Error(secret); } })
  ];
  for (const input of malformed) {
    const error = new FoundationError("PROCESS_FAILED", secret);
    associateProcessFailureFacts(error, input);
    assert.equal(readProcessFailureFacts(error), undefined);
    assert.equal(report(error).capability.problem?.message, "An unexpected process failure occurred.");
  }
  assert.equal(getters, 0);
  const input = { reason: "exit", exitCode: 4_294_967_295 };
  const error = new FoundationError("PROCESS_FAILED", secret);
  associateProcessFailureFacts(error, input);
  input.exitCode = 12;
  associateProcessFailureFacts(error, { reason: "launch" });
  assert.equal(readProcessFailureFacts(error)?.exitCode, 4_294_967_295);
  assert.equal(Object.isFrozen(readProcessFailureFacts(error)), true);
  assert.equal(readProcessFailureFacts(Object.create(error)), undefined);
  assert.equal(readProcessFailureFacts({ ...error }), undefined);
  assert.equal(readProcessFailureFacts(new Proxy(error, {})), undefined);
  assert.equal(report(new ProcessTimeoutError(NaN)).capability.problem?.message, "An unexpected process failure occurred.");
  const spoof = new FoundationError("PROCESS_FAILED", secret);
  Object.defineProperty(spoof, "processFailureFacts", { get() { getters++; throw new Error(secret); } });
  assert.equal(report(spoof).capability.problem?.message, "An unexpected process failure occurred.");
  assert.equal(getters, 0);
  assert.equal(report({ name: "PackageScriptTimeoutError", timeoutMs: 500, message: secret }).capability.problem?.message, "An unexpected process failure occurred.");
  for (const [facts, message] of [
    [{ reason: "exit", exitCode: 0 }, "The process exited unsuccessfully. Observed exit code: 0."],
    [{ reason: "timeout", timeoutMs: 1 }, "The process timed out. Timeout: 1ms."],
    [{ reason: "timeout", timeoutMs: 2_147_483_647 }, "The process timed out. Timeout: 2147483647ms."]
  ] as const) {
    const boundary = new FoundationError("PROCESS_FAILED", secret);
    associateProcessFailureFacts(boundary, facts);
    assert.equal(report(boundary).capability.problem?.message, message);
  }
  const hostile = new Proxy({}, { get() { throw new Error(secret); }, getPrototypeOf() { throw new Error(secret); } });
  assert.equal(report(hostile).capability.problem?.code, "UNEXPECTED_FAILURE");
});

// Regression: enrichment changes cancellation precedence, nonprocess mapping or success bytes.
test("cancellation and nonprocess outcomes and successful bytes remain unchanged", async () => {
  const cancelled = new ProcessCancellationError(secret, { cause: new Error(secret) });
  const { capability, aggregate } = report(cancelled);
  assert.equal(capability.problem?.code, "EXECUTION_CANCELLED");
  assert.equal(capability.problem?.message, "Capability execution was cancelled.");
  assert.equal(aggregate.outcome, "cancelled");
  assert.equal(exitCodeForOutcome(aggregate.outcome), 130);
  assert.equal(readProcessFailureFacts(cancelled)?.reason, "cancelled");
  for (const [error, code] of [[new SyntaxError(secret), "UNEXPECTED_PARSER_FAILURE"], [new TypeError(secret), "UNEXPECTED_CONTRACT_FAILURE"], [new Error(secret), "UNEXPECTED_FAILURE"]] as const) {
    assert.equal(report(error).capability.problem?.code, code);
  }
  const invalid = report(new CapabilityInputError({ code: "FIXTURE_INVALID", message: "Invalid fixture input.", phase: "input", retryable: false }, { cause: new Error(secret) }));
  assert.equal(invalid.aggregate.outcome, "invalid-input");
  assert.equal(exitCodeForOutcome(invalid.aggregate.outcome), 2);
  const runner = new NodeProcessRunner();
  assert.deepEqual(await runner.run({ command: process.execPath, args: ["-e", "process.stdout.write('ok\\n');process.stderr.write('err\\n')"], cwd: process.cwd() }), { stdout: "ok\n", stderr: "err\n" });
  const passed = foundationReport({ foundationVersion: "fixture", coverage: "full" });
  assert.equal(JSON.stringify(passed), '{"reportSchemaVersion":1,"foundationVersion":"fixture","coverage":"full","outcome":"passed","summary":{"errors":0,"warnings":0,"infos":0},"capabilities":[]}');
});

// Regression: the real runner discards observed exit metadata when stderr is nonempty.
test("real process exit survives reporting while stderr remains private", { timeout: 15_000 }, async () => {
  await assert.rejects(new NodeProcessRunner().run({
    command: process.execPath, args: ["-e", `process.stderr.write('${secret}');process.exitCode=23`], cwd: process.cwd(), timeoutMs: 5000
  }), (error: unknown) => {
    assert.equal(report(error).capability.problem?.message, "The process exited unsuccessfully. Observed exit code: 23.");
    return true;
  });
});

// Regression: launch/output/deadline failures are falsely projected as child exits.
test("real producer branches identify launch, timeout and invalid output", { timeout: 15_000 }, async () => {
  for (const [run, message] of [
    [() => new NodeProcessRunner().run(request), "The process could not be started."],
    [() => new NodeProcessRunner().run({ command: process.execPath, args: ["-e", "setInterval(()=>{},60000)"], cwd: process.cwd(), timeoutMs: 50 }), "The process timed out. Timeout: 50ms."],
    [() => new NodeProcessRunner().run({ command: process.execPath, args: ["-e", "process.stdout.write(Buffer.alloc(4*1024*1024+1))"], cwd: process.cwd(), timeoutMs: 5000 }), "Process output exceeded the capture limit."],
    [() => executeManagedProcess({ command: process.execPath, args: ["-e", "process.stdout.write(Buffer.from([255]))"], cwd: process.cwd(), strictUtf8: true }), "Process output was not valid UTF-8."]
  ] as const) {
    await assert.rejects(run(), (error: unknown) => { assert.equal(report(error).capability.problem?.message, message); return true; });
  }
});

// Regression: a signal-only exit is mislabeled with the runner's synthetic code 1.
test("signal exit reports only actually observed metadata", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  await assert.rejects(new NodeProcessRunner().run({ command: process.execPath, args: ["-e", "process.kill(process.pid,'SIGTERM')"], cwd: process.cwd() }), (error: unknown) => {
    assert.equal(report(error).capability.problem?.message, "The process exited unsuccessfully. Observed signal: SIGTERM.");
    return true;
  });
});
