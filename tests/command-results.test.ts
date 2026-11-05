import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixture = fileURLToPath(new URL("./support/command-host-fixture.ts", import.meta.url));

function runScenario(scenario: string): unknown {
  const result = spawnSync(process.execPath, [fixture, scenario], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 65_536,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout) as unknown;
}

function observation(scenario: string) {
  const value = runScenario(scenario);
  assert.ok(typeof value === "object" && value !== null);
  assert.ok("stdout" in value && typeof value.stdout === "string");
  assert.ok("stderr" in value && value.stderr === "");
  assert.ok("exitCode" in value && typeof value.exitCode === "number");
  assert.ok("created" in value && value.created === 1);
  assert.ok("events" in value && Array.isArray(value.events));
  assert.ok("publications" in value && Array.isArray(value.publications));
  const events: readonly unknown[] = value.events;
  const publications: readonly unknown[] = value.publications;
  return {
    stdout: value.stdout,
    stderr: value.stderr,
    exitCode: value.exitCode,
    created: value.created,
    events,
    publications,
  };
}

function expectedReport(id: string, coverage: "full" | "selected") {
  // Independent expected wire data; no report constructor imported from production.
  return {
    reportSchemaVersion: 1,
    foundationVersion: "3.0.0",
    coverage,
    outcome: "violations",
    summary: { errors: 1, warnings: 0, infos: 0 },
    capabilities: [
      {
        capabilityId: id,
        capabilityConfigSchemaVersion: 1,
        outcome: "violations",
        summary: { errors: 1, warnings: 0, infos: 0 },
        diagnostics: [],
      },
    ],
  };
}

test("rejected lexical and buffered-command admission never constructs services", () => {
  const results = runScenario("invalid");
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 10);
  for (const result of results as readonly unknown[]) {
    assert.ok(typeof result === "object" && result !== null);
    assert.ok("created" in result && result.created === 0);
    assert.ok("events" in result);
    assert.deepEqual(result.events, []);
    assert.ok("exitCode" in result && result.exitCode === 2);
  }
});

test("check retains its report, selected input and signal lifetime through publication", () => {
  const json = observation("check");
  assert.deepEqual(JSON.parse(json.stdout), expectedReport("example.rule", "full"));
  assert.equal(json.exitCode, 1);
  assert.deepEqual(json.events, ["subscribe:SIGINT", "version", "check:all", "dispose"]);
  assert.deepEqual(json.publications, [{ stream: "stdout", signals: ["SIGINT"] }]);
  const text = observation("check-text");
  assert.equal(text.stdout, "CHECK full violations\n");
  assert.equal(text.exitCode, 1);
  assert.deepEqual(text.events, ["subscribe:SIGINT", "version", "check:example.rule", "dispose"]);
});

test("quality commands retain their own declarations, scope and selected-report contract", () => {
  const check = observation("quality-check");
  assert.deepEqual(JSON.parse(check.stdout), expectedReport("quality.source-coverage", "selected"));
  assert.equal(check.exitCode, 1);
  assert.deepEqual(check.events, [
    "subscribe:SIGINT,SIGTERM",
    "config",
    "quality-check:true",
    "version",
    "dispose",
  ]);
  assert.deepEqual(check.publications, [{ stream: "stdout", signals: ["SIGINT", "SIGTERM"] }]);
  const format = observation("quality-format");
  assert.equal(format.stdout, "CHECK selected violations\n");
  assert.equal(format.exitCode, 1);
  assert.deepEqual(format.events, [
    "subscribe:SIGINT,SIGTERM",
    "config",
    "quality-format:false",
    "version",
    "dispose",
  ]);
});

test("baseline checks and writes retain distinct reports, effects and remaining-finding exits", () => {
  const check = observation("baseline-check");
  assert.deepEqual(
    JSON.parse(check.stdout),
    expectedReport("quality.findings-baseline", "selected"),
  );
  assert.equal(check.exitCode, 1);
  assert.deepEqual(check.events, [
    "subscribe:SIGINT,SIGTERM",
    "baseline-check",
    "version",
    "dispose",
  ]);
  const write = observation("baseline-write");
  assert.equal(
    write.stdout,
    "Findings baseline init baseline.json: 2 entries, 1 lowered, 1 removed.\nNot accepted (new): src/index.ts example.rule\n",
  );
  assert.equal(write.exitCode, 1);
  assert.deepEqual(write.events, ["subscribe:SIGINT,SIGTERM", "baseline-init", "dispose"]);
  assert.deepEqual(write.publications, [{ stream: "stdout", signals: ["SIGINT", "SIGTERM"] }]);
});

test("local-mode buffered results preserve status, mutation inputs and command-specific exits", () => {
  const root = resolve("fixture-consumer");
  const status = observation("status");
  assert.deepEqual(JSON.parse(status.stdout), {
    mode: "INVALID",
    consumerRoot: root,
    dependencySpec: "3.0.0",
    issues: ["fixture issue"],
  });
  assert.equal(status.exitCode, 1);
  const text = observation("status-text");
  assert.equal(
    text.stdout,
    `Foundation mode: INVALID\nConsumer: ${root}\nDeclared version: 3.0.0\nIssue: fixture issue\n`,
  );
  assert.equal(text.exitCode, 1);
  const attach = observation("attach");
  assert.deepEqual(JSON.parse(attach.stdout), { mode: "LOCAL", consumerRoot: root, issues: [] });
  assert.deepEqual(attach.events, ["attach:target"]);
  assert.equal(attach.exitCode, 17, "successful attach does not reset caller exit state");
  const detach = observation("detach");
  assert.deepEqual(JSON.parse(detach.stdout), { mode: "REGISTRY", consumerRoot: root, issues: [] });
  assert.deepEqual(detach.events, ["detach"]);
  assert.equal(detach.exitCode, 17);
  assert.equal(observation("registry").stdout, `Foundation mode: REGISTRY\nConsumer: ${root}\n`);
  assert.equal(
    observation("dev-only").stdout,
    `Foundation dependency policy: DEV_ONLY\nConsumer: ${root}\n`,
  );
});

test("information output preserves aliases, exact schema bytes and package metadata", () => {
  const version = observation("version");
  assert.equal(version.stdout, "3.0.0\n");
  assert.equal(version.exitCode, 17);
  assert.deepEqual(version.events, ["version"]);
  const schema = observation("schema");
  assert.equal(schema.stdout, '{"schema":true}\n');
  assert.deepEqual(schema.events, ["schema:example/v1"]);
  assert.deepEqual(JSON.parse(observation("self-check").stdout), {
    ok: true,
    packageName: "fixture",
  });
  assert.match(observation("help").stdout, /^Usage:\n/u);
});

test("delegated output and architecture promotion keep their established owners", () => {
  const gate = observation("gate");
  assert.equal(gate.stdout, "gate streaming\n");
  assert.equal(gate.exitCode, 7);
  assert.deepEqual(gate.events, ["gate:verify"]);
  const workflow = observation("workflow");
  assert.equal(workflow.stdout, "workflow first\nworkflow second\n");
  assert.equal(workflow.exitCode, 5);
  assert.deepEqual(workflow.events, [
    "config",
    "subscribe:SIGINT,SIGTERM",
    "changed:HEAD",
    "dispose",
  ]);
  assert.deepEqual(workflow.publications, [
    { stream: "stdout", signals: ["SIGINT", "SIGTERM"] },
    { stream: "stdout", signals: ["SIGINT", "SIGTERM"] },
  ]);
  const scaffold = observation("scaffold");
  assert.equal(scaffold.stdout, "scaffold-owned\n");
  assert.equal(scaffold.exitCode, 6);
  const decisions = observation("decisions");
  assert.deepEqual(JSON.parse(decisions.stdout), { promotion: { writeResult: "written" } });
  assert.deepEqual(decisions.events, ["config", "decisions"]);
});

test("admitted audit failure and cancellation retain audit envelopes and exit two", () => {
  for (const [scenario, message] of [
    ["audit-failed", "Error: audit failed"],
    ["audit-cancelled", "ProcessCancellationError: audit cancelled"],
  ] as const) {
    const result = observation(scenario);
    assert.equal(result.exitCode, 2);
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: 1,
      operation: "public-api-audit",
      releaseEligible: false,
      evidenceComplete: false,
      exitCode: 2,
      errors: [message],
    });
    assert.deepEqual(result.events, ["subscribe:SIGINT,SIGTERM", "audit", "dispose"]);
    assert.equal(result.publications.length, 1);
  }
});

test("JSON never observes text renderers and text preserves their service receiver", () => {
  for (const [scenario, id, coverage] of [
    ["check-lazy-renderer", "example.rule", "full"],
    ["quality-lazy-renderer", "quality.source-coverage", "selected"],
    ["baseline-lazy-renderer", "quality.findings-baseline", "selected"],
  ] as const) {
    const result = observation(scenario);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(JSON.parse(result.stdout), expectedReport(id, coverage));
  }
  for (const [scenario, coverage] of [
    ["check-text", "full"],
    ["quality-format", "selected"],
    ["baseline-text", "selected"],
  ] as const) {
    const result = observation(scenario);
    assert.equal(result.stdout, `CHECK ${coverage} violations\n`);
    assert.equal(result.exitCode, 1);
  }
});
