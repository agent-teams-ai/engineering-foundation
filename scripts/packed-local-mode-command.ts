import assert from "node:assert/strict";
import { runCommand } from "./pack-test-support.mjs";

export interface PackedLocalModeCommand {
  readonly consumerRoot: string;
  readonly foundationCli: string;
}

interface CommandStreams {
  readonly stdout: string;
  readonly stderr: string;
}

export function localModeRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function commandStreams(value: unknown): CommandStreams {
  const result = localModeRecord(value);
  return { stdout: text(result["stdout"]), stderr: text(result["stderr"]) };
}

export function localModeJson(stdout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout);
  return localModeRecord(value);
}

/** Use the existing bounded process owner, including its native cleanup contract. */
export async function runPackedFoundation(
  input: PackedLocalModeCommand,
  args: readonly string[],
): Promise<CommandStreams> {
  const result: unknown = await runCommand(
    process.execPath,
    [input.foundationCli, ...args],
    input.consumerRoot,
  );
  return commandStreams(result);
}

export async function rejectPackedFoundation(
  input: PackedLocalModeCommand,
  args: readonly string[],
  expectedExitCode: number,
): Promise<CommandStreams> {
  try {
    await runPackedFoundation(input, args);
  } catch (error) {
    const failure = localModeRecord(error);
    assert.equal(failure["code"], expectedExitCode, `Unexpected exit for ${args.join(" ")}`);
    assert.equal(failure["timedOut"], false, "A command deadline is not a semantic rejection.");
    assert.equal(failure["terminationConfirmed"], true);
    return commandStreams(failure);
  }
  throw new Error(`Packed Foundation accepted ${args.join(" ")}.`);
}

interface AdmissionCase {
  readonly args: readonly string[];
  readonly format: "json" | "text";
  readonly message: RegExp;
}

const unknownOption = /Unknown option: --unknown/u;
const duplicateFormat = /--json or --format may be specified only once/u;
const extraPositional = /positional|argument/iu;
const admissionCases: readonly AdmissionCase[] = [
  { args: ["--unknown", "--format", "json"], format: "json", message: unknownOption },
  { args: ["--format", "json", "--unknown"], format: "json", message: unknownOption },
  { args: ["--unknown", "--format", "text"], format: "text", message: unknownOption },
  { args: ["--consumer", "--json"], format: "json", message: /--consumer requires a value/u },
  { args: ["--config", "--format", "json"], format: "json", message: /--config requires a value/u },
  {
    args: ["--format", "xml", "--json"],
    format: "json",
    message: /--format requires json or text/u,
  },
  { args: ["--format", "text", "--json"], format: "json", message: duplicateFormat },
  { args: ["--json", "--format", "text"], format: "json", message: duplicateFormat },
  { args: ["--format", "json", "--format", "json"], format: "json", message: duplicateFormat },
  { args: ["--format", "text", "--format", "text"], format: "text", message: duplicateFormat },
  { args: ["--", "--json"], format: "text", message: extraPositional },
  { args: ["--", "--format", "json"], format: "text", message: extraPositional },
  { args: ["--unknown", "--", "--json"], format: "text", message: unknownOption },
  { args: ["--format", "json", "--", "--json"], format: "json", message: extraPositional },
];

function assertAdmissionFailure(
  streams: CommandStreams,
  format: "json" | "text",
  message: RegExp,
): void {
  if (format === "text") {
    assert.equal(streams.stdout, "", "Text admission failures must not publish a JSON envelope.");
    assert.match(streams.stderr, /^CONSUMER_INVALID: /u);
    assert.match(streams.stderr, message);
    return;
  }
  assert.equal(streams.stderr, "");
  assert.equal(streams.stdout.trim().split("\n").length, 1, "Expected one JSON failure envelope.");
  const envelope = localModeJson(streams.stdout);
  assert.equal(envelope["schemaVersion"], 1);
  assert.equal(envelope["outcome"], "invalid-input");
  assert.equal(envelope["operation"], undefined, "Parse failure must not become an audit result.");
  const failure = localModeRecord(envelope["error"]);
  assert.equal(failure["code"], "CONSUMER_INVALID");
  assert.equal(failure["retryable"], false);
  assert.match(text(failure["message"]), message);
}

export async function verifyPackedCommandAdmission(
  input: PackedLocalModeCommand,
  localTarget: string,
): Promise<void> {
  for (const scenario of admissionCases) {
    const streams = await rejectPackedFoundation(input, ["status", ...scenario.args], 2);
    assertAdmissionFailure(streams, scenario.format, scenario.message);
  }
  const commandToken = await rejectPackedFoundation(input, ["--json"], 2);
  assertAdmissionFailure(commandToken, "text", /Unknown command/u);
  const audit = await rejectPackedFoundation(
    input,
    ["public-api-audit", "--unknown", "--format", "json"],
    2,
  );
  assertAdmissionFailure(audit, "json", unknownOption);
  const attach = await rejectPackedFoundation(input, ["attach", localTarget, "--", "--json"], 2);
  assertAdmissionFailure(attach, "text", extraPositional);
}

export async function verifyPackedOrdinaryCommands(
  input: PackedLocalModeCommand,
  packageVersion: string,
): Promise<void> {
  const version = await runPackedFoundation(input, ["version"]);
  assert.equal(version.stdout, `${packageVersion}\n`);
  assert.equal(version.stderr, "");
  const help = await runPackedFoundation(input, ["help"]);
  assert.match(help.stdout, /^Usage:\n/u);
  assert.equal(help.stderr, "");
  const selfCheck = await runPackedFoundation(input, ["self-check", "--json"]);
  const metadata = localModeJson(selfCheck.stdout);
  assert.equal(metadata["ok"], true);
  assert.equal(metadata["packageVersion"], packageVersion);
  assert.equal(selfCheck.stderr, "");
  for (const format of ["text", "json"]) {
    const status = await runPackedFoundation(input, ["status", "--format", format]);
    assert.equal(status.stderr, "");
    if (format === "json") {
      assert.equal(localModeJson(status.stdout)["mode"], "REGISTRY");
    } else {
      assert.match(status.stdout, /^Foundation mode: REGISTRY\n/u);
    }
  }
}
