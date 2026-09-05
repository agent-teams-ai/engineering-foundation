import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateFeatureModules } from "../scripts/check-feature-modules.mjs";
import { CapabilityInputError, FoundationError } from "../packages/engineering-foundation/dist/features/validation-reporting/api.js";
import { parseArguments } from "../packages/engineering-foundation/dist/features/command-host/adapters/inbound/cli/cli-arguments.js";
import { foundationCommandFailure } from "../packages/engineering-foundation/dist/features/command-host/adapters/inbound/cli/command-error.js";
import { renderFoundationReportText } from "../packages/engineering-foundation/dist/features/foundation-check/adapters/inbound/cli/report-renderer.js";
import { createStrictYamlFileLoader, createSchemaCatalog } from "../packages/engineering-foundation/dist/features/configuration-input/module.js";
import { parseStrictYamlSource } from "../packages/engineering-foundation/dist/features/configuration-input/yaml.js";
import { ContainedFileReadError } from "../packages/engineering-foundation/dist/source-inventory/api.js";
import { FilesystemSourceTreeReader } from "../packages/engineering-foundation/dist/source-inventory/adapters/outbound/filesystem/filesystem-source-tree-reader.js";
import { PnpmWorkspaceInventoryReader } from "../packages/engineering-foundation/dist/workspace-inventory/adapters/outbound/pnpm/pnpm-workspace-inventory-reader.js";
import { readPnpmPackageManifestSnapshots } from "../packages/engineering-foundation/dist/workspace-inventory/adapters/outbound/pnpm/pnpm-package-manifest-snapshot-reader.js";
import { ProcessCancellationError, ProcessTimeoutError } from "../packages/engineering-foundation/dist/process-execution/api.js";
import { NodeProcessRunner } from "../packages/engineering-foundation/dist/process-execution/node-process-runner.js";
import { managedProcessCleanupFailure } from "../packages/engineering-foundation/dist/process-execution/windows-managed-process-diagnostics.js";
import { inspectFoundationPackage } from "../packages/engineering-foundation/dist/local-mode/adapters/node/package-inspection.js";
import { createNodeLocalTargetReader } from "../packages/engineering-foundation/dist/local-mode/adapters/node/target-reader.js";
import { restoreRegistryEntry } from "../packages/engineering-foundation/dist/local-mode/adapters/node/registry-recovery.js";
import { NodeFoundationOperationLock } from "../packages/engineering-foundation/dist/transaction-coordination/adapters/node/node-foundation-operation-lock.js";

const cancellation = { code: "EXECUTION_CANCELLED", message: "Foundation check was cancelled.", phase: "execution", retryable: false };
function problem(expected) {
  return (error) => {
    assert.ok(error instanceof CapabilityInputError);
    assert.deepEqual(error.problem, { ...expected, retryable: false });
    assert.equal(error.message, expected.message);
    return true;
  };
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foundation-reporting-rest-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Keep stream interception out of the test runner's own IPC channel.
function commandFailureObservation(options) {
  const base = new URL("../packages/engineering-foundation/dist/", import.meta.url);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { runInNewContext } from "node:vm";
    import { CapabilityInputError, FoundationError } from ${JSON.stringify(new URL("features/validation-reporting/api.js", base).href)};
    import { runFoundationCli } from ${JSON.stringify(new URL("features/command-host/adapters/inbound/cli/foundation-cli.js", base).href)};
    const options = ${JSON.stringify(options)};
    const { kind, codes = [], message = "invalid invocation", format = "text" } = options;
    const cause = { identity: "original cause" };
    let thenReads = 0;
    const thenable = Object.defineProperty({}, "then", { get() { thenReads++; throw cause; } });
    const sentinels = { error: new Error("accessor sentinel", { cause }), undefined, null: null, symbol: Symbol("sentinel"), thenable };
    const sentinel = sentinels[options.sentinel ?? "error"];
    const errors = {
      foundation: () => new FoundationError(codes[0], message, { cause }),
      capability: () => new CapabilityInputError({ code: codes[0], message, phase: "caller", retryable: true }, { cause }),
      native: () => new Error(message, { cause }),
      foreign: () => runInNewContext('new Error("foreign failure")'),
      undefined: () => undefined, null: () => null, false: () => false, number: () => 42,
      string: () => "primitive failure", symbol: () => Symbol("failure"), thenable: () => thenable
    };
    const error = errors[kind]();
    const trace = [];
    let codeReads = 0, messageReads = 0;
    if (kind === "foundation" || kind === "capability") {
      const target = kind === "foundation" ? error : error.problem;
      Object.defineProperty(target, "code", { get() {
        trace.push("code");
        if (++codeReads === options.throwCodeRead) throw sentinel;
        assert.ok(codeReads <= 2, "unexpected extra code read");
        return codes[codeReads - 1];
      } });
    }
    if (error instanceof Error) {
      Object.defineProperty(kind === "capability" ? error.problem : error, "message", { get() {
        trace.push("message");
        if (++messageReads === options.throwMessageRead) throw sentinel;
        assert.equal(messageReads, 1, "unexpected extra message read");
        return message;
      } });
    }
    const stdoutWrite = process.stdout.write, stderrWrite = process.stderr.write, previousExitCode = process.exitCode;
    let stdout = "", stderr = "", rejected = false, thrown, exitCode;
    process.stdout.write = (text) => { trace.push("stdout"); stdout += text; return true; };
    process.stderr.write = (text) => {
      trace.push("stderr");
      if (options.throwWrite) throw sentinel;
      stderr += text;
      if (options.writeCode !== undefined) codes[1] = options.writeCode;
      return true;
    };
    process.exitCode = 17;
    try {
      const args = ["status", ...(format === "json" ? ["--json"] : format === "format-json" ? ["--format", "json"] : [])];
      await runFoundationCli(() => { throw error; }, args);
    } catch (failure) { rejected = true; thrown = failure; }
    finally {
      exitCode = process.exitCode;
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
      process.exitCode = previousExitCode;
    }
    if (rejected) assert.equal(thrown, sentinel, "thrown value identity");
    if (error instanceof Error) assert.equal(error.cause, cause, "original cause identity");
    assert.equal(thenReads, 0, "must not assimilate a thrown thenable");
    console.log(JSON.stringify({ trace, codeReads, messageReads, stdout, stderr, exitCode, rejected }));
  `], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

const commandErrorKinds = [
  { kind: "foundation", ordinary: "PROCESS_FAILED", classified: "CONSUMER_INVALID", ordinaryExit: 1, classifiedExit: 2, ordinaryOutcome: "execution-failure", classifiedOutcome: "invalid-input" },
  { kind: "capability", ordinary: "INPUT_INVALID", classified: "EXECUTION_CANCELLED", ordinaryExit: 2, classifiedExit: 130, ordinaryOutcome: "invalid-input", classifiedOutcome: "cancelled" }
];

test("command text preserves code/message reads, publication order and thrown identity", { concurrency: 1 }, async (t) => {
  for (const { kind, ordinary, classified, ordinaryExit, classifiedExit } of commandErrorKinds) {
    for (const [first, second, exitCode] of [[ordinary, ordinary, ordinaryExit], [ordinary, classified, classifiedExit], [classified, ordinary, ordinaryExit]]) {
      await t.test(`${kind}: ${first} then ${second}`, () => {
        assert.deepEqual(commandFailureObservation({ kind, codes: [first, second] }), {
          trace: ["code", "message", "stderr", "code"], codeReads: 2, messageReads: 1,
          stdout: "", stderr: `${first}: invalid invocation\n`, exitCode, rejected: false
        });
      });
    }
    for (const sentinel of ["error", "undefined", "null", "symbol", "thenable"]) {
      for (const throwCodeRead of [1, 2]) {
        await t.test(`${kind}: ${sentinel} thrown on code read ${throwCodeRead}`, () => {
          const published = throwCodeRead === 2;
          const first = kind === "foundation" ? classified : ordinary;
          assert.deepEqual(commandFailureObservation({ kind, codes: [first, classified], throwCodeRead, sentinel }), {
            trace: published ? ["code", "message", "stderr", "code"] : ["code"], codeReads: throwCodeRead, messageReads: published ? 1 : 0,
            stdout: "", stderr: published ? `${first}: invalid invocation\n` : "", exitCode: 17, rejected: true
          });
        });
      }
    }
    await t.test(`${kind}: message accessor throws before publication`, () => {
      assert.deepEqual(commandFailureObservation({ kind, codes: [ordinary, classified], throwMessageRead: 1 }), {
        trace: ["code", "message"], codeReads: 1, messageReads: 1, stdout: "", stderr: "", exitCode: 17, rejected: true
      });
    });
    await t.test(`${kind}: failed write prevents classification`, () => {
      assert.deepEqual(commandFailureObservation({ kind, codes: [ordinary, classified], throwWrite: true }), {
        trace: ["code", "message", "stderr"], codeReads: 1, messageReads: 1, stdout: "", stderr: "", exitCode: 17, rejected: true
      });
    });
    await t.test(`${kind}: classification observes a code changed during publication`, () => {
      assert.deepEqual(commandFailureObservation({ kind, codes: [ordinary, ordinary], writeCode: classified }), {
        trace: ["code", "message", "stderr", "code"], codeReads: 2, messageReads: 1,
        stdout: "", stderr: `${ordinary}: invalid invocation\n`, exitCode: classifiedExit, rejected: false
      });
    });
  }
});

test("command JSON retains classification before message reads and publication", { concurrency: 1 }, async (t) => {
  for (const { kind, ordinary, classified, ordinaryExit, classifiedExit, ordinaryOutcome, classifiedOutcome } of commandErrorKinds) {
    for (const format of ["json", "format-json"]) {
      for (const [first, second, exitCode, outcome] of [[ordinary, classified, ordinaryExit, ordinaryOutcome], [classified, ordinary, classifiedExit, classifiedOutcome]]) {
        await t.test(`${kind}: ${format}, ${first} then ${second}`, () => {
          const message = "m".repeat(1100);
          assert.deepEqual(commandFailureObservation({ kind, codes: [first, second], message, format }), {
            trace: ["code", "code", "message", "stdout"], codeReads: 2, messageReads: 1,
            stdout: `${JSON.stringify({ schemaVersion: 1, outcome, error: { code: second, message: kind === "capability" ? message : message.slice(0, 1000), retryable: kind === "capability" } })}\n`,
            stderr: "", exitCode, rejected: false
          });
        });
      }
      for (const throwCodeRead of [1, 2]) {
        await t.test(`${kind}: ${format}, code read ${throwCodeRead} throws`, () => {
          assert.deepEqual(commandFailureObservation({ kind, codes: [ordinary, classified], format, throwCodeRead }), {
            trace: Array(throwCodeRead).fill("code"), codeReads: throwCodeRead, messageReads: 0, stdout: "", stderr: "", exitCode: 17, rejected: true
          });
        });
      }
      await t.test(`${kind}: ${format}, message accessor throws`, () => {
        assert.deepEqual(commandFailureObservation({ kind, codes: [ordinary, classified], format, throwMessageRead: 1 }), {
          trace: ["code", "code", "message"], codeReads: 2, messageReads: 1, stdout: "", stderr: "", exitCode: 17, rejected: true
        });
      });
    }
  }
});

test("command unknown failures retain text, JSON, accessor and thenable behavior", { concurrency: 1 }, async (t) => {
  for (const [kind, message] of [["native", "invalid invocation"], ["foreign", "Error: foreign failure"], ["undefined", "undefined"], ["null", "null"], ["false", "false"], ["number", "42"], ["string", "primitive failure"], ["symbol", "Symbol(failure)"], ["thenable", "[object Object]"]]) {
    for (const format of ["text", "json"]) {
      await t.test(`${kind}: ${format}`, () => {
        assert.deepEqual(commandFailureObservation({ kind, format }), {
          trace: [...(kind === "native" ? ["message"] : []), format === "text" ? "stderr" : "stdout"], codeReads: 0, messageReads: kind === "native" ? 1 : 0,
          stdout: format === "json" ? `${JSON.stringify({ schemaVersion: 1, outcome: "execution-failure", error: { code: "UNEXPECTED", message, retryable: false } })}\n` : "",
          stderr: format === "text" ? `UNEXPECTED: ${message}\n` : "", exitCode: 1, rejected: false
        });
      });
    }
  }
  for (const format of ["text", "json"]) {
    await t.test(`unknown message accessor throws: ${format}`, () => {
      assert.deepEqual(commandFailureObservation({ kind: "native", format, throwMessageRead: 1 }), {
        trace: ["message"], codeReads: 0, messageReads: 1, stdout: "", stderr: "", exitCode: 17, rejected: true
      });
    });
  }
});

test("the seventeen remaining reporting adapters reach only their own application policy", async () => {
  const result = await validateFeatureModules();
  const owned = ["features/command-host/", "features/configuration-input/", "features/foundation-check/", "local-mode/", "process-execution/", "source-inventory/", "workspace-inventory/", "transaction-coordination/"];
  assert.equal(result.modules, 6);
  assert.deepEqual(result.problems.filter(({ code }) => ["input-error", "source-policy", "unowned-source", "unowned-edge"].includes(code)), []);
  assert.deepEqual(result.problems.filter(({ code, message }) => code === "layer-direction" && owned.some((root) => message.startsWith(`packages/engineering-foundation/src/${root}`)) && message.includes(" -> packages/engineering-foundation/src/features/validation-reporting/")), []);
});

test("command failures preserve identity, retryability, JSON bounds and text bytes", () => {
  const errors = [
    [new CapabilityInputError(cancellation), "EXECUTION_CANCELLED", 130, "cancelled"],
    [new CapabilityInputError({ code: "INPUT", message: "input message", phase: "caller", retryable: true }), "INPUT", 2, "invalid-input"],
    [new ProcessCancellationError("stopped"), "PROCESS_CANCELLED", 130, "cancelled"],
    [new FoundationError("CONSUMER_INVALID", "bad input"), "CONSUMER_INVALID", 2, "invalid-input"],
    [new FoundationError("PROCESS_FAILED", "x".repeat(1100)), "PROCESS_FAILED", 1, "execution-failure"],
    [new ProcessTimeoutError(15), "PROCESS_FAILED", 1, "execution-failure"]
  ];
  for (const [error, code, exitCode, outcome] of errors) {
    const result = foundationCommandFailure(error);
    assert.equal(result.exitCode, exitCode);
    assert.deepEqual(result.envelope, { schemaVersion: 1, outcome, error: { code, message: error instanceof CapabilityInputError ? error.message : error.message.slice(0, 1000), retryable: error instanceof CapabilityInputError && error.problem.retryable } });
    for (const json of [false, true]) {
      const expression = error instanceof CapabilityInputError ? `new CapabilityInputError(${JSON.stringify(error.problem)})`
        : error instanceof ProcessCancellationError ? `new ProcessCancellationError(${JSON.stringify(error.message)})`
          : `new FoundationError(${JSON.stringify(error.code)}, ${JSON.stringify(error.message)})`;
      const base = new URL("../packages/engineering-foundation/dist/", import.meta.url);
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { CapabilityInputError, FoundationError } from ${JSON.stringify(new URL("features/validation-reporting/api.js", base).href)};
        import { ProcessCancellationError } from ${JSON.stringify(new URL("process-execution/api.js", base).href)};
        import { runFoundationCli } from ${JSON.stringify(new URL("features/command-host/adapters/inbound/cli/foundation-cli.js", base).href)};
        await runFoundationCli(() => { throw ${expression}; }, ${JSON.stringify(["status", ...(json ? ["--json"] : [])])});
      `], { encoding: "utf8" });
      const { stdout, stderr } = child;
      assert.equal(child.status, exitCode, stderr);
      assert.equal(stdout, json ? `${JSON.stringify(result.envelope)}\n` : "");
      assert.equal(stderr, json ? "" : `${code}: ${error.message}\n`);
    }
  }
  assert.throws(() => parseArguments(["check", "--consumer"]), (error) => error instanceof FoundationError && error.code === "CONSUMER_INVALID" && error.message === "--consumer requires a value.");
});

test("YAML and schema diagnostics keep caller phases and reader failures keep identity", async (t) => {
  const root = await fixture(t);
  const failure = new Error("IO identity");
  const loader = createStrictYamlFileLoader({ read: async () => { throw failure; } });
  await assert.rejects(loader(root, "config.yaml", "caller"), (error) => error === failure);
  const cancelled = createStrictYamlFileLoader({ read: async () => assert.fail("read after cancellation") });
  await assert.rejects(cancelled(root, "config.yaml", "caller", AbortSignal.abort()), problem(cancellation));
  let checkpoints = 0;
  const afterRead = createStrictYamlFileLoader({ read: async () => Buffer.from("key: value\n") });
  await assert.rejects(afterRead(root, "config.yaml", "caller", { get aborted() { return ++checkpoints > 1; } }), problem(cancellation));
  assert.equal(checkpoints, 2);
  assert.throws(() => parseStrictYamlSource("key: &anchor value\n", "caller"), problem({ code: "YAML_FEATURE_PROHIBITED", message: "YAML anchors and explicit tags are prohibited.", phase: "caller" }));
  assert.deepEqual(parseStrictYamlSource("key: value\n", "caller"), { key: "value" });
  const catalog = createSchemaCatalog({ schemaIds: ["item"], dependencies: {}, readSchema: async () => '{"$id":"https://fixture.invalid/item","type":"string"}' });
  await assert.rejects(catalog.assertSchema("item", 1, "schema-caller"), problem({ code: "SCHEMA_INVALID", message: "/ must be string", phase: "schema-caller" }));
  await catalog.assertSchema("item", "valid", "schema-caller");
});

test("source and workspace readers retain cancellation, attribution and bytes", async (t) => {
  const root = await fixture(t);
  const signal = AbortSignal.abort(new Error("do not expose"));
  await assert.rejects(new FilesystemSourceTreeReader().read(join(root, "missing"), ["src"], signal), problem(cancellation));
  await assert.rejects(readPnpmPackageManifestSnapshots(root, ["package.json"], [], signal), problem(cancellation));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/file.ts"), "bad\0bytes");
  await assert.rejects(new FilesystemSourceTreeReader().read(root, ["src"]), problem({ code: "SOURCE_FILE_INVALID", message: "Source file contains prohibited NUL bytes: src/file.ts.", phase: "source-read" }));
  assert.equal(await readFile(join(root, "src/file.ts"), "utf8"), "bad\0bytes");
  await writeFile(join(root, "package.json"), '{"name":"fixture","dependencies":{"bad":42}}\n');
  await assert.rejects(readPnpmPackageManifestSnapshots(root, ["package.json"], []), problem({ code: "GOVERNED_INPUT_INVALID", message: "package.json dependencies must contain non-empty string values.", phase: "package-manifest" }));
  assert.throws(() => new PnpmWorkspaceInventoryReader().discoverManifestPathsFromManifest(root, { packages: "bad" }), problem({ code: "PNPM_WORKSPACE_INVALID", message: "pnpm-workspace.yaml packages must contain repository-relative POSIX glob patterns.", phase: "workspace-discovery" }));
});

test("process launch and cleanup reporting preserves causes and diagnostic ordering", async () => {
  const runner = new NodeProcessRunner();
  const cause = new Error("cancel reason");
  await assert.rejects(runner.run({ command: "never-execute", args: [], cwd: "/missing", signal: AbortSignal.abort(cause) }), (error) => error instanceof ProcessCancellationError && error.cause === cause && error.message === "never-execute  was cancelled before it started.");
  const request = { command: "fixture", args: ["argument"], cwd: "/missing" };
  for (const windows of [false, true]) {
    const error = managedProcessCleanupFailure(request, cause, [], windows);
    assert.ok(error instanceof FoundationError);
    assert.equal(error.code, "PROCESS_FAILED");
    assert.equal(error.cause, cause);
    assert.equal(error.message, windows ? "could not clean up its process tree after exit. [windows-containment=unknown;wrapper-phase=unreported] fixture argument" : "fixture argument could not clean up its process tree after exit.");
  }
});

test("local package failures retain causes and registry recovery leaves evidence intact", async (t) => {
  const root = await fixture(t);
  await assert.rejects(inspectFoundationPackage(root, { packageFileAllowlist: [], requiredArtifactPaths: [] }), (error) => error instanceof FoundationError && error.code === "PACKAGE_INVALID" && error.cause.code === "ENOENT" && error.message === "Foundation target package.json cannot be read.");
  await writeFile(join(root, "package.json"), '{"name":"@agent-teams/engineering-foundation"}');
  const reader = createNodeLocalTargetReader({ run: async () => assert.fail("target must fail before process") }, async () => assert.fail("self-target must fail before inspection"));
  await assert.rejects(reader.verify(root, root), (error) => error instanceof FoundationError && error.message === "Foundation target cannot be the consumer repository.");
  await assert.rejects(restoreRegistryEntry(root, "1.0.0", undefined, async () => assert.fail("sync after invalid recovery")), (error) => error instanceof FoundationError && error.code === "LOCAL_STATE_INVALID" && error.message === "Registry backup is unavailable and the installed package cannot be proven to be the original registry entry.");
  assert.equal(await readFile(join(root, "package.json"), "utf8"), '{"name":"@agent-teams/engineering-foundation"}');
});

test("operation lock maps acquisition failure without replacing its cause", async (t) => {
  const root = await fixture(t);
  const release = await new NodeFoundationOperationLock(root).acquire();
  try {
    await assert.rejects(new NodeFoundationOperationLock(root).acquire(), (error) => error instanceof FoundationError && error.code === "LOCAL_STATE_INVALID" && error.message === error.cause.message && error.cause.name === "RepositoryMutationError");
  } finally { await release(); }
});

test("check report text is a byte-stable projection", () => {
  const report = { outcome: "invalid-input", foundationVersion: "fixture", coverage: "selected", summary: { errors: 1, warnings: 0, infos: 0 }, problem: { code: "ROOT", message: "root problem" }, capabilities: [{ capabilityId: "fixture.capability", outcome: "violations", diagnostics: [{ location: { path: "src/a.ts", start: { line: 2, column: 3 } }, severity: "error", ruleId: "fixture.rule", message: "diagnostic", remediation: "fix" }] }] };
  assert.equal(renderFoundationReportText(report), "Foundation check: invalid-input\nFoundation version: fixture\nCoverage: selected\nDiagnostics: 1 error(s), 0 warning(s), 0 info\nProblem ROOT: root problem\n\nfixture.capability: violations\nsrc/a.ts:2:3 ERROR fixture.rule\n  diagnostic\n  Fix: fix\n");
});

test("contained configuration failures retain canonical mapping and invalid-root attribution", async (t) => {
  const root = await fixture(t);
  for (const [failure, code, message] of [
    ["escape", "CONFIG_PATH_ESCAPE", "Configuration path escapes the consumer repository: config.yaml."],
    ["invalid", "CONFIG_FILE_INVALID", "Configuration file must be a regular file no larger than 1048576 bytes: config.yaml."],
    ["symlink", "CONFIG_SYMLINK_PROHIBITED", "Configuration path cannot be a symbolic link: config.yaml."],
    ["changed", "CONFIG_FILE_UNAVAILABLE", "Required configuration file is unavailable or changed while reading: config.yaml."]
  ]) {
    const load = createStrictYamlFileLoader({ read: async () => { throw new ContainedFileReadError(failure); } });
    await assert.rejects(load(root, "config.yaml", "owned-phase"), problem({ code, message, phase: "owned-phase" }));
  }
  const file = join(root, "file");
  await writeFile(file, "immutable");
  const load = createStrictYamlFileLoader({ read: async () => assert.fail("invalid root must precede reader") });
  await assert.rejects(load(file, "config.yaml", "owned-phase"), problem({ code: "CONSUMER_ROOT_INVALID", message: "Consumer root must be an existing directory.", phase: "owned-phase" }));
});

test("lock release failure retains successor bytes and the mutation error as its cause", async (t) => {
  const root = await fixture(t);
  const release = await new NodeFoundationOperationLock(root).acquire();
  const lock = join(root, ".agent-teams-local", "foundation-operation.lock");
  const original = await readFile(lock);
  await rename(lock, `${lock}.displaced`);
  const successor = '{"foreign":"preserve this exact evidence"}\n';
  await writeFile(lock, successor);
  await assert.rejects(release(), (error) => {
    assert.ok(error instanceof FoundationError);
    assert.equal(error.code, "LOCAL_STATE_INVALID");
    assert.equal(error.message, "Foundation could not release the shared mutation lock without violating ownership.");
    assert.equal(error.cause.name, "RepositoryMutationError");
    assert.equal(error.cause.code, "MUTATION_LEASE_INVALID");
    return true;
  });
  assert.equal(await readFile(lock, "utf8"), successor);
  assert.deepEqual(await readFile(`${lock}.displaced`), original);
});
