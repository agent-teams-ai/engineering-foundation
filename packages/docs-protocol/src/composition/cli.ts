import type { DocumentJsonValue } from "@agent-teams/engineering-foundation/document-authoring";

import { DocsProtocol } from "../application/docs-protocol.js";
import { NodeFoundationDocsPort } from "../adapters/foundation-docs-port.js";
import { NodeDocsProfileReader } from "../adapters/node-profile-reader.js";
import { NodeCodeAnchorMatcher } from "../adapters/node-code-anchor-matcher.js";
import { NodeDocsAdoptionInspector } from "../adapters/node-adoption-inspector.js";
import { assertDocsCommandEnvelopeSchema } from "../adapters/docs-command-envelope-schema-validator.js";
import {
  DOCS_PROTOCOL_ID,
  DOCS_PROTOCOL_VERSION,
  type DocsCommand,
  type DocsCommandEnvelope,
  type DocsExecution,
  type DocsFindQuery
} from "../domain/model.js";
import { DocsProfileError } from "../domain/profile-policy.js";
import {
  consumerIntegrationHelp,
  runConsumerIntegrationCli
} from "../consumer-integration/composition/consumer-integration-cli.js";

interface CommonArguments {
  readonly consumerRoot: string;
  readonly json: boolean;
  readonly profilePath: string;
  readonly signal: AbortSignal;
}

class CliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliInputError";
  }
}

class Arguments {
  readonly #values: string[];
  readonly #used = new Set<number>();

  constructor(values: readonly string[]) {
    const separator = values.indexOf("--");
    this.#values = separator === -1
      ? [...values]
      : [...values.slice(0, separator), ...values.slice(separator + 1)];
  }

  flag(name: string): boolean {
    const indexes = this.#values.flatMap((value, index) => value === name ? [index] : []);
    if (indexes.length > 1) {throw new CliInputError(`${name} may be supplied only once.`);}
    if (indexes[0] !== undefined) {this.#used.add(indexes[0]);}
    return indexes.length === 1;
  }

  one(name: string, required = false): string | undefined {
    const indexes = this.#values.flatMap((value, index) => value === name ? [index] : []);
    if (indexes.length > 1) {throw new CliInputError(`${name} may be supplied only once.`);}
    const index = indexes[0];
    if (index === undefined) {
      if (required) {throw new CliInputError(`${name} is required.`);}
      return undefined;
    }
    const value = this.#values[index + 1];
    if (value === undefined || value.startsWith("--")) {throw new CliInputError(`${name} requires a value.`);}
    this.#used.add(index);
    this.#used.add(index + 1);
    return value;
  }

  many(name: string): readonly string[] {
    const results: string[] = [];
    for (let index = 0; index < this.#values.length; index += 1) {
      if (this.#values[index] !== name) {continue;}
      const value = this.#values[index + 1];
      if (value === undefined || value.startsWith("--")) {throw new CliInputError(`${name} requires a value.`);}
      this.#used.add(index);
      this.#used.add(index + 1);
      results.push(value);
    }
    return Object.freeze(results);
  }

  positionals(): readonly string[] {
    return Object.freeze(this.#values.filter((_value, index) => !this.#used.has(index)));
  }
}

function common(args: Arguments, signal: AbortSignal): CommonArguments {
  return {
    consumerRoot: args.one("--consumer") ?? ".",
    profilePath: args.one("--profile") ?? "architecture/foundation/docs-protocol.yaml",
    json: args.flag("--json"),
    signal
  };
}

function parseJson(value: string, subject: string): DocumentJsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new CliInputError(`${subject} must contain strict JSON.`);
  }
  validateJson(parsed, subject, 0);
  return parsed as DocumentJsonValue;
}

function validateJson(value: unknown, subject: string, depth: number): void {
  if (depth > 16) {throw new CliInputError(`${subject} exceeds the JSON nesting limit.`);}
  if (value === null || typeof value === "string" || typeof value === "boolean") {return;}
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {throw new CliInputError(`${subject} numbers must be safe integers.`);}
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) {throw new CliInputError(`${subject} array is too large.`);}
    value.forEach((entry, index) => { validateJson(entry, `${subject}[${index}]`, depth + 1); });
    return;
  }
  if (typeof value !== "object") {throw new CliInputError(`${subject} is outside the JSON data model.`);}
  const entries = Object.entries(value);
  if (entries.length > 256) {throw new CliInputError(`${subject} object is too large.`);}
  for (const [key, entry] of entries) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {throw new CliInputError(`${subject} contains a forbidden key.`);}
    validateJson(entry, `${subject}.${key}`, depth + 1);
  }
}

function parseMetadata(values: readonly string[]): Readonly<Record<string, DocumentJsonValue>> | undefined {
  if (values.length === 0) {return undefined;}
  const metadata: Record<string, DocumentJsonValue> = Object.create(null) as Record<string, DocumentJsonValue>;
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) {throw new CliInputError("--metadata uses key=<strict JSON>.");}
    const key = value.slice(0, separator);
    if (!/^[a-z][a-z0-9_]*$/u.test(key) || Object.hasOwn(metadata, key)) {throw new CliInputError(`Metadata key ${key} is invalid or duplicate.`);}
    metadata[key] = parseJson(value.slice(separator + 1), `metadata.${key}`);
  }
  return Object.freeze(metadata);
}

function parseCodeAnchor(value: string, index: number): DocumentJsonValue {
  const legacy = /^(advisory|required):(.+)$/u.exec(value);
  if (legacy !== null) {
    return Object.freeze({ enforcement: legacy[1]!, pattern: legacy[2]! });
  }
  return parseJson(value, `code-anchor[${index}]`);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function isInputError(error: unknown, code: string | undefined): boolean {
  return error instanceof CliInputError || error instanceof DocsProfileError ||
    (code !== undefined && /^DOCUMENT_[A-Z_]+_INPUT_INVALID$/u.test(code)) ||
    (error instanceof Error && error.name === "InvalidDocumentAuthoringProfileError");
}

function isAuthorityInputError(error: unknown, code: string | undefined): boolean {
  return code?.startsWith("DOCUMENT_") === true ||
    (error instanceof Error && (
      error.name === "InvalidDocumentAuthoringProfileError" ||
      /document authoring profile|Foundation authoring profile/u.test(error.message)
    ));
}

type MachineFailureKind = "authority" | "cancelled" | "filesystem" | "internal" | "process" | "validation";

function machineFailureKind(error: unknown, cancelled: boolean, inputInvalid: boolean, authorityInvalid: boolean): MachineFailureKind {
  if (cancelled) {return "cancelled";}
  if (authorityInvalid) {return "authority";}
  if (inputInvalid || error instanceof SyntaxError || error instanceof TypeError) {return "validation";}
  const code = errorCode(error);
  if (code?.startsWith("PROCESS_") === true || (error instanceof Error && /process|spawn/u.test(error.name))) {return "process";}
  if (code !== undefined && /^(?:EACCES|EEXIST|EISDIR|ELOOP|EMFILE|ENAMETOOLONG|ENOENT|ENOSPC|ENOTDIR|EPERM|EROFS)$/u.test(code)) {return "filesystem";}
  return "internal";
}

function machineErrorMessage(outcome: "cancelled" | "execution-failure" | "invalid-input", authorityInvalid: boolean): string {
  if (outcome === "cancelled") {return "Documentation command was cancelled.";}
  if (outcome === "invalid-input") {
    return authorityInvalid ? "Documentation authority is invalid." : "Documentation command input is invalid.";
  }
  return "Documentation command failed.";
}

export function docsCliErrorExecution(command: DocsCommand, error: unknown, machine: boolean): DocsExecution<Readonly<Record<string, never>>> {
  const code = errorCode(error);
  const cancelled = error instanceof Error && error.name === "AbortError";
  const inputInvalid = isInputError(error, code);
  const outcome = cancelled ? "cancelled" as const : inputInvalid ? "invalid-input" as const : "execution-failure" as const;
  const authorityInvalid = inputInvalid && isAuthorityInputError(error, code);
  const phase = cancelled ? "apply" as const : authorityInvalid ? "authority" as const : inputInvalid ? "input" as const : "apply" as const;
  const baseRuleId = cancelled ? "docs.cli.cancelled" : inputInvalid ? "docs.cli.invalid-input" : "docs.cli.execution-failure";
  const failureKind = machineFailureKind(error, cancelled, inputInvalid, authorityInvalid);
  return {
    exitCode: cancelled ? 130 : inputInvalid ? 2 : 3,
    envelope: {
      schemaVersion: 1,
      protocol: { id: DOCS_PROTOCOL_ID, version: DOCS_PROTOCOL_VERSION },
      command,
      outcome,
      diagnostics: [{
        ruleId: machine ? `${baseRuleId}.${failureKind}` : baseRuleId,
        severity: "error",
        phase,
        subject: command,
        message: machine
          ? machineErrorMessage(outcome, authorityInvalid)
          : error instanceof Error ? error.message : "Unknown command failure.",
      }],
      result: Object.freeze({})
    }
  };
}

function commandId(value: string | undefined): DocsCommand {
  switch (value) {
    case "check": return "docs.check";
    case "doctor": return "docs.doctor";
    case "find": return "docs.find";
    case "info": return "docs.info";
    case "new": return "docs.new";
    case "recover": return "docs.recover";
    case undefined:
    default: return "docs.info";
  }
}

async function dispatchFind(protocol: DocsProtocol, args: Arguments, options: CommonArguments) {
  const explicitText = args.one("--text");
  const id = args.one("--id");
  const type = args.one("--type");
  const status = args.one("--status");
  const owner = args.one("--owner");
  const related = args.one("--related");
  const blockedBy = args.one("--blocked-by");
  const positionals = args.positionals();
  if (positionals.length > 1 || (positionals.length === 1 && explicitText !== undefined)) {
    throw new CliInputError("Supply search text once, positionally or with --text.");
  }
  const text = explicitText ?? positionals[0];
  const query: DocsFindQuery = {
    ...(text === undefined ? {} : { text }),
    ...(id === undefined ? {} : { id }),
    ...(type === undefined ? {} : { type }),
    ...(status === undefined ? {} : { status }),
    ...(owner === undefined ? {} : { owner }),
    ...(related === undefined ? {} : { related }),
    ...(blockedBy === undefined ? {} : { blockedBy })
  };
  return { execution: await protocol.find({ ...options, query }), json: options.json };
}

async function dispatchNew(protocol: DocsProtocol, args: Arguments, options: CommonArguments) {
  const dryRun = args.flag("--dry-run");
  const apply = args.flag("--apply");
  if (dryRun === apply) {
    throw new CliInputError("Exactly one of --dry-run or --apply is required.");
  }
  const related = args.many("--related");
  const blockedBy = args.many("--blocked-by");
  const codeAnchors = args.many("--code-anchor").map(parseCodeAnchor);
  const metadata = parseMetadata(args.many("--metadata"));
  const type = args.one("--type", true)!;
  const id = args.one("--id", true)!;
  const title = args.one("--title", true)!;
  const owner = args.one("--owner", true)!;
  const summary = args.one("--summary", true)!;
  const slug = args.one("--slug");
  const destination = args.one("--destination");
  if (args.positionals().length !== 0) {
    throw new CliInputError("Unknown docs:new arguments.");
  }
  return {
    execution: await protocol.newDocument({
      ...options,
      apply,
      intent: { type, id, title, owner, summary, ...(slug === undefined ? {} : { slug }), ...(destination === undefined ? {} : { destination }) },
      ...(related.length === 0 ? {} : { related }),
      ...(blockedBy.length === 0 ? {} : { blockedBy }),
      ...(codeAnchors.length === 0 ? {} : { codeAnchors }),
      ...(metadata === undefined ? {} : { additionalMetadata: metadata })
    }),
    json: options.json
  };
}

async function dispatch(protocol: DocsProtocol, command: string, values: readonly string[], signal: AbortSignal): Promise<{ readonly execution: DocsExecution<unknown>; readonly json: boolean }> {
  const args = new Arguments(values);
  const options = common(args, signal);
  if (command === "info") {
    if (args.positionals().length !== 0) {throw new CliInputError("docs:info accepts no positional arguments.");}
    return { execution: await protocol.info(options), json: options.json };
  }
  if (command === "find") {
    return dispatchFind(protocol, args, options);
  }
  if (command === "new") {
    return dispatchNew(protocol, args, options);
  }
  if (command === "doctor") {
    if (args.positionals().length !== 0) {throw new CliInputError("docs:doctor accepts no positional arguments.");}
    return { execution: await protocol.doctor(options), json: options.json };
  }
  if (command === "recover") {
    if (args.positionals().length !== 0) {throw new CliInputError("docs:recover accepts no positional arguments.");}
    return { execution: await protocol.recover(options), json: options.json };
  }
  if (command === "check") {
    if (args.positionals().length !== 0) {throw new CliInputError("docs:check accepts no positional arguments.");}
    return { execution: await protocol.check(options), json: options.json };
  }
  throw new CliInputError("Expected one command: info, find, new, doctor, recover, or check.");
}

function reachabilitySummary(value: unknown): string {
  const reachability = value as Record<string, unknown>;
  return [reachability["kind"], reachability["indexPath"], reachability["reason"]]
    .filter((entry) => typeof entry === "string")
    .join(" ");
}

function display(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
}

function renderInfo(result: Record<string, unknown>): readonly string[] {
  const lines = [`Project: ${display(result["projectId"])}`];
  for (const value of Array.isArray(result["types"]) ? result["types"] : []) {
    const type = value as Record<string, unknown>;
    const identity = type["identity"] as Record<string, unknown>;
    const placement = type["placement"] as Record<string, unknown>;
    lines.push(`Type ${String(type["type"])} | initial ${String(type["initialStatus"])} | owners ${(type["allowedOwnerIds"] as unknown[]).join(",")} | identity ${String(identity["format"])} | placement ${String(placement["kind"])} | required ${(type["requiredMetadata"] as unknown[]).join(",")} | reachability ${reachabilitySummary(type["reachability"])}`);
  }
  lines.push(`Semantic validators: ${(result["semanticValidatorIds"] as unknown[]).join(",") || "none"}`);
  return lines;
}

function renderFind(result: Record<string, unknown>): readonly string[] {
  const lines = [`Matches: ${display(result["matches"], "0")}`];
  for (const value of Array.isArray(result["documents"]) ? result["documents"] : []) {
    const document = value as Record<string, unknown>;
    lines.push(`${String(document["id"])} | ${String(document["type"])} | ${String(document["status"])} | ${String(document["owner"])} | ${String(document["repositoryPath"])} | ${String(document["title"])}`);
  }
  return lines;
}

export function renderDocsHuman(envelope: DocsCommandEnvelope): string {
  const result = envelope.result as Record<string, unknown>;
  const lines = [`${envelope.command}: ${envelope.outcome}`];
  if (envelope.command === "docs.info") {
    lines.push(...renderInfo(result));
  }
  if (envelope.command === "docs.find") {
    lines.push(...renderFind(result));
  }
  if (envelope.command === "docs.new" && typeof result["documentPath"] === "string") {
    lines.push(`Document: ${result["documentPath"]}`);
    const reachability = result["reachability"] as Record<string, unknown> | undefined;
    const indexable = ["preview", "applied", "already-applied"].includes(display(result["writeState"]));
    if (indexable && reachability?.["state"] === "manual-required") {lines.push(`Next: add ${String(reachability["markdownLink"])} to ${String(reachability["indexPath"])}`);}
    if (result["writeState"] === "published-recovery-required") {lines.push("Next: recover the published transaction before editing reachability indexes.");}
  }
  if (envelope.command === "docs.doctor") {
    lines.push(`Project: ${display(result["projectId"])}`);
    lines.push(`Environment: ${JSON.stringify(result["environment"] ?? {})}`);
    lines.push(`Transaction: ${JSON.stringify(result["transaction"] ?? {})}`);
  }
  if (envelope.command === "docs.check") {
    lines.push(`Project: ${display(result["projectId"])}`);
    lines.push(`Catalog: ${String(result["catalogStatus"])} (${String(result["documents"])} documents)`);
    lines.push(`Adoption: ${result["valid"] === true ? "valid" : "invalid"}`);
  }
  if (envelope.command === "docs.recover") {
    lines.push(`Recovery: ${display(result["transactionState"])} (${display(result["writeState"])})`);
  }
  for (const diagnostic of envelope.diagnostics) {lines.push(`${diagnostic.severity.toUpperCase()} ${diagnostic.ruleId}: ${diagnostic.message}`);}
  return `${lines.join("\n")}\n`;
}

function helpText(command?: string): string {
  if (command === "new") {
    return "Usage: agent-teams-docs new --type TYPE --id ID --title TITLE --owner OWNER --summary SUMMARY (--dry-run|--apply) [--related ID] [--blocked-by ID] [--code-anchor required:PATTERN] [--metadata key=JSON]\n";
  }
  if (command === "find") {
    return "Usage: agent-teams-docs find [TEXT|--text TEXT] [--id ID] [--type TYPE] [--status STATUS] [--owner OWNER] [--related ID] [--blocked-by ID]\n";
  }
  if (["info", "doctor", "recover", "check"].includes(command ?? "")) {
    return `Usage: agent-teams-docs ${command} [--consumer PATH] [--profile PATH] [--json]\n`;
  }
  return "Usage: agent-teams-docs <info|find|new|doctor|recover|check|consumer> [options]\nRun 'agent-teams-docs consumer --help' for maintainer integration commands.\n";
}

export async function validatedMachineExecution(
  id: DocsCommand,
  execution: DocsExecution<unknown>
): Promise<DocsExecution<unknown>> {
  try {
    await assertDocsCommandEnvelopeSchema(execution.envelope);
    return execution;
  } catch {
    const fallback: DocsExecution<Readonly<Record<string, never>>> = {
      exitCode: 3,
      envelope: {
        schemaVersion: 1,
        protocol: { id: DOCS_PROTOCOL_ID, version: DOCS_PROTOCOL_VERSION },
        command: id,
        outcome: "execution-failure",
        diagnostics: [{
          ruleId: "docs.cli.invalid-output.internal",
          severity: "error",
          phase: "apply",
          subject: id,
          message: "Documentation command produced invalid output."
        }],
        result: Object.freeze({})
      }
    };
    await assertDocsCommandEnvelopeSchema(fallback.envelope);
    return fallback;
  }
}

export function runDocsCli(argv: readonly string[]): Promise<number>;
export async function runDocsCli(
  argv: readonly string[],
  protocolFactory: () => DocsProtocol = () => new DocsProtocol({
    adoption: new NodeDocsAdoptionInspector(),
    anchors: new NodeCodeAnchorMatcher(),
    foundation: new NodeFoundationDocsPort(),
    profiles: new NodeDocsProfileReader()
  })
): Promise<number> {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalizedArgv[0] === "consumer") {
    if (normalizedArgv.length === 2 && normalizedArgv[1] === "--help") {
      process.stdout.write(consumerIntegrationHelp());
      return 0;
    }
    return runConsumerIntegrationCli(normalizedArgv.slice(1));
  }
  if (
    (normalizedArgv.length === 1 && (normalizedArgv[0] === "--help" || normalizedArgv[0] === "help")) ||
    (normalizedArgv.length === 2 && normalizedArgv[1] === "--help")
  ) {
    process.stdout.write(helpText(normalizedArgv.length === 2 ? normalizedArgv[0] : undefined));
    return 0;
  }
  const command = normalizedArgv[0];
  const id = commandId(command);
  const controller = new AbortController();
  const cancel = () => { controller.abort(new DOMException("Documentation command was cancelled.", "AbortError")); };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let json = normalizedArgv.includes("--json");
  let execution: DocsExecution<unknown>;
  try {
    const dispatched = await dispatch(protocolFactory(), command ?? "", normalizedArgv.slice(1), controller.signal);
    execution = dispatched.execution;
    json = dispatched.json;
  } catch (error) {
    execution = docsCliErrorExecution(id, error, json);
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
  if (json) {
    execution = await validatedMachineExecution(id, execution);
  }
  process.stdout.write(json ? `${JSON.stringify(execution.envelope)}\n` : renderDocsHuman(execution.envelope));
  return execution.exitCode;
}
