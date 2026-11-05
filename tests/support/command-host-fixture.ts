import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { runFoundationCli } from "../../packages/engineering-foundation/dist/features/command-host/adapters/inbound/cli/foundation-cli.js";
import type {
  FoundationCommandServices,
  CommandSignal,
} from "../../packages/engineering-foundation/dist/features/command-host/api.js";
import type {
  CapabilityReport,
  FoundationCheckReport,
} from "../../packages/engineering-foundation/dist/features/validation-reporting/api.js";
import { ProcessCancellationError } from "../../packages/engineering-foundation/dist/process-execution/api.js";

async function unavailable(): Promise<never> {
  throw new Error("Unexpected fixture service invocation");
}

function capability(id: string): CapabilityReport {
  return {
    capabilityId: id,
    capabilityConfigSchemaVersion: 1,
    outcome: "violations",
    summary: { errors: 1, warnings: 0, infos: 0 },
    diagnostics: [],
  };
}

const checkReport: FoundationCheckReport = {
  reportSchemaVersion: 1,
  foundationVersion: "3.0.0",
  coverage: "full",
  outcome: "violations",
  summary: { errors: 1, warnings: 0, infos: 0 },
  capabilities: [capability("example.rule")],
};

interface Observation {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: string | number | undefined;
  readonly created: number;
  readonly events: readonly string[];
  readonly publications: readonly {
    readonly stream: "stdout" | "stderr";
    readonly signals: readonly CommandSignal[];
  }[];
}

interface FixtureSignals {
  active: readonly CommandSignal[];
  current: AbortSignal | undefined;
}

function text(chunk: unknown): string {
  assert.ok(typeof chunk === "string");
  return chunk;
}

function createLocalMode(events: string[]): FoundationCommandServices["localMode"] {
  return {
    attach: async (root, target) => {
      events.push(`attach:${target}`);
      return {
        targetPackageRoot: target,
        status: { mode: "LOCAL", consumerRoot: root, issues: [] },
      };
    },
    detach: async (root) => {
      events.push("detach");
      return { mode: "REGISTRY", consumerRoot: root, issues: [] };
    },
    status: async (root) => {
      events.push("status");
      return {
        mode: "INVALID",
        consumerRoot: root,
        dependencySpec: "3.0.0",
        issues: ["fixture issue"],
      };
    },
    assertDevOnly: async (root) => {
      events.push("dev-only");
      return { consumerRoot: root, issues: [] };
    },
    assertRegistry: async (root) => {
      events.push("registry");
      return { mode: "REGISTRY", consumerRoot: root, issues: [] };
    },
  };
}

function createFixtureServices(
  events: string[],
  signals: FixtureSignals,
  caseName: string,
): FoundationCommandServices {
  const observedSignal = (signal: AbortSignal | undefined): void => {
    assert.equal(signal, signals.current);
    assert.ok(signal !== undefined);
  };
  const services: FoundationCommandServices = {
    cancellation: {
      async withSignal(requestedSignals, operation) {
        assert.deepEqual(signals.active, []);
        signals.active = [...requestedSignals];
        signals.current = new AbortController().signal;
        events.push(`subscribe:${requestedSignals.join(",")}`);
        try {
          return await operation(signals.current);
        } finally {
          events.push("dispose");
          signals.active = [];
          signals.current = undefined;
        }
      },
    },
    check: async (input) => {
      observedSignal(input.signal);
      events.push(`check:${input.capabilityId ?? "all"}`);
      assert.equal(input.consumerRoot, resolve("fixture-consumer"));
      assert.equal(input.foundationVersion, "3.0.0");
      return checkReport;
    },
    renderCheck(report) {
      assert.equal(this, services, "text rendering retains the service receiver");
      return `CHECK ${report.coverage} ${report.outcome}\n`;
    },
    installedVersion: async () => {
      events.push("version");
      return "3.0.0";
    },
    readConfig: async (root, signal) => {
      events.push("config");
      if (caseName.startsWith("quality")) {
        observedSignal(signal);
      }
      assert.equal(root, resolve("fixture-consumer"));
      return {
        projectId: "fixture",
        declaredCapabilities: [
          { id: "quality.source-coverage", configPath: "source.yaml" },
          { id: "quality.format-coverage", configPath: "format.yaml" },
          { id: "repository.agent-workflow", configPath: "workflow.yaml" },
          { id: "governance.architecture-decisions", configPath: "decisions.yaml" },
        ],
      };
    },
    localMode: createLocalMode(events),
    qualityGate: async (input) => {
      if (input.command !== "gate.run") {
        return false;
      }
      events.push(`gate:${input.positional.join(",")}`);
      process.stdout.write("gate streaming\n");
      process.exitCode = 7;
      return true;
    },
    qualityCoverage: async (input) => {
      observedSignal(input.signal);
      assert.equal(input.configPath, "source.yaml");
      events.push(`quality-check:${input.scopeOnly}`);
      return capability("quality.source-coverage");
    },
    qualityFormat: async (input) => {
      observedSignal(input.signal);
      assert.equal(input.configPath, "format.yaml");
      events.push(`quality-format:${input.scopeOnly}`);
      return capability("quality.format-coverage");
    },
    findingsBaseline: {
      check: async (input) => {
        observedSignal(input.signal);
        assert.equal(input.configPath, "baseline.yaml");
        events.push("baseline-check");
        return capability("quality.findings-baseline");
      },
      write: async (input) => {
        observedSignal(input.signal);
        assert.equal(input.configPath, "baseline.yaml");
        events.push(`baseline-${input.action}`);
        return {
          action: input.action,
          path: "baseline.json",
          entries: 2,
          lowered: 1,
          removed: 1,
          remaining: [{ kind: "new", path: "src/index.ts", rule: "example.rule" }],
        };
      },
    },
    agentWorkflow: {
      changed: async (input) => {
        observedSignal(input.signal);
        events.push(`changed:${input.baseRef}`);
        process.stdout.write("workflow first\n");
        process.stdout.write("workflow second\n");
        process.exitCode = 5;
      },
      checkChanged: unavailable,
      instructions: unavailable,
    },
    rules: new Map(),
    promoteDecisions: async (input) => {
      assert.equal(input.configPath, "decisions.yaml");
      events.push("decisions");
      return { writeResult: "written" };
    },
    auditPublicApi: async () => {
      events.push("audit");
      if (caseName === "audit-cancelled") {
        throw new ProcessCancellationError("audit cancelled");
      }
      throw new Error("audit failed");
    },
    nativePublicApiTransition: unavailable,
    promotePublicApi: unavailable,
    loadProtobufQualifier: unavailable,
    scaffold: async (input) => {
      if (input.command !== "scaffold-recover") {
        return false;
      }
      events.push("scaffold");
      process.stdout.write("scaffold-owned\n");
      process.exitCode = 6;
      return true;
    },
    inspectPackage: async () => {
      events.push("inspect");
      return { ok: true, packageName: "fixture" };
    },
    isSchemaId: (value): value is string => value === "example/v1",
    readSchema: async (id) => {
      events.push(`schema:${id}`);
      return '{"schema":true}\n';
    },
  };
  return services;
}

async function observe(args: readonly string[], caseName: string): Promise<Observation> {
  const events: string[] = [];
  const signals: FixtureSignals = { active: [], current: undefined };
  let created = 0;
  const publications: { stream: "stdout" | "stderr"; signals: readonly CommandSignal[] }[] = [];
  let stdout = "",
    stderr = "";
  const previous = process.exitCode;
  const writeOut = process.stdout.write,
    writeErr = process.stderr.write;
  process.stdout.write = (chunk: unknown) => {
    publications.push({ stream: "stdout", signals: [...signals.active] });
    stdout += text(chunk);
    return true;
  };
  process.stderr.write = (chunk: unknown) => {
    publications.push({ stream: "stderr", signals: [...signals.active] });
    stderr += text(chunk);
    return true;
  };
  process.exitCode = 17;
  const create = (): FoundationCommandServices => {
    created++;
    const services = createFixtureServices(events, signals, caseName);
    if (caseName.endsWith("-lazy-renderer")) {
      Object.defineProperty(services, "renderCheck", {
        get() {
          throw new Error("JSON must not observe the text renderer");
        },
      });
    }
    return services;
  };
  try {
    await runFoundationCli(create, args);
    assert.deepEqual(signals.active, []);
    return { stdout, stderr, exitCode: process.exitCode, created, events, publications };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
    process.exitCode = previous;
  }
}

async function scenario(name: string): Promise<unknown> {
  const consumer = ["--consumer", "fixture-consumer"];
  const json = ["--format", "json"];
  if (name === "invalid") {
    const results: Observation[] = [];
    for (const args of [
      ["check", "--unknown", ...json],
      ["status", "--", "--json"],
      ["attach"],
      ["quality", "unsupported"],
      ["baseline", "unsupported", "--config", "baseline.yaml"],
      ["help", "--json"],
      ["version", "--json"],
      ["schema"],
      ["unknown", "--json"],
      ["public-api-audit", ...json],
    ]) {
      results.push(await observe(args, name));
    }
    return results;
  }
  const invocations = new Map<string, readonly string[]>([
    ["check", ["check", ...consumer, ...json]],
    ["check-lazy-renderer", ["check", ...consumer, ...json]],
    ["quality-lazy-renderer", ["quality", "check", ...consumer, ...json]],
    [
      "baseline-lazy-renderer",
      ["baseline", "check", "--config", "baseline.yaml", ...consumer, ...json],
    ],
    ["baseline-text", ["baseline", "check", "--config", "baseline.yaml", ...consumer]],
    ["check-text", ["repo", "check", "example.rule", ...consumer]],
    ["quality-check", ["quality", "check", "--scope-only", ...consumer, ...json]],
    ["quality-format", ["quality", "format", ...consumer]],
    ["baseline-check", ["baseline", "check", "--config", "baseline.yaml", ...consumer, ...json]],
    ["baseline-write", ["baseline", "init", "--config", "baseline.yaml", ...consumer]],
    ["status", ["status", ...consumer, ...json]],
    ["status-text", ["status", ...consumer]],
    ["attach", ["attach", "target", ...consumer, ...json]],
    ["detach", ["detach", ...consumer, ...json]],
    ["registry", ["assert-registry", ...consumer]],
    ["dev-only", ["assert-dev-only", ...consumer]],
    ["version", ["--version"]],
    ["help", ["-h"]],
    ["schema", ["schema", "example/v1"]],
    ["self-check", ["self-check"]],
    ["gate", ["gate", "run", "verify", ...consumer]],
    ["workflow", ["agent-workflow", "changed", "--base", "HEAD", ...consumer]],
    ["scaffold", ["scaffold-recover", ...consumer]],
    ["decisions", ["architecture-decisions-promote-baseline", ...consumer, ...json]],
    ["audit-failed", ["public-api-audit", "--config", "audit.json", ...consumer, ...json]],
    ["audit-cancelled", ["public-api-audit", "--config", "audit.json", ...consumer, ...json]],
  ]);
  const invocation = invocations.get(name);
  if (invocation === undefined) {
    throw new Error(`Unknown scenario ${name}`);
  }
  return observe(invocation, name);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await scenario(process.argv[2] ?? ""))}\n`);
}
