import type { DocumentJsonValue } from "@agent-teams/document-authoring";

import { DocsProtocol } from "../application/docs-protocol.js";
import { NodeDocumentAuthoringPort } from "../adapters/document-authoring-port.js";
import { NodeDocsProfileReader } from "../adapters/node-profile-reader.js";
import { NodeCodeAnchorMatcher } from "../adapters/node-code-anchor-matcher.js";
import { NodeDocsAdoptionInspector } from "../adapters/node-adoption-inspector.js";
import { discoverDocsProfilePath } from "../adapters/node-profile-discovery.js";
import type {
  DocsCommandV3,
  DocsFindQueryV3
} from "../domain/model-v3.js";
import {
  MAXIMUM_COMMUNITY_CONTEXT_BYTES,
  MAXIMUM_COMMUNITY_CONTEXT_DOCUMENTS,
  MINIMUM_COMMUNITY_CONTEXT_BYTES
} from "../community/context/index.js";
import { Arguments, CliInputError } from "./cli-input.js";
import {
  commandEnvelopeVersion,
  directExecution,
  docsCliErrorExecution,
  validatedMachineExecution,
  type DocsMachineExecution
} from "./docs-cli-machine.js";
import { renderDocsHumanV2, renderDocsHumanV3 } from "./docs-human-renderer.js";
import {
  docsInitApply,
  docsInitApplyPreflight,
  docsInitPlan,
  docsInitRecover
} from "./node-docs-bootstrap-api.js";

export { renderDocsHumanV2, renderDocsHumanV3 } from "./docs-human-renderer.js";
export { docsCliErrorExecution, validatedMachineExecution } from "./docs-cli-machine.js";

interface CommonArguments {
  readonly consumerRoot: string;
  readonly json: boolean;
  readonly profilePath: string;
  readonly signal: AbortSignal;
}


async function common(args: Arguments, signal: AbortSignal): Promise<CommonArguments> {
  const consumerRoot = args.one("--consumer") ?? ".";
  const explicitProfilePath = args.one("--profile");
  return {
    consumerRoot,
    profilePath: await discoverDocsProfilePath({
      consumerRoot,
      ...(explicitProfilePath === undefined ? {} : { explicitProfilePath })
    }),
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

function commandId(value: string | undefined): DocsCommandV3 {
  switch (value) {
    case "check": return "docs.check";
    case "context": return "docs.context";
    case "doctor": return "docs.doctor";
    case "find": return "docs.find";
    case "info": return "docs.info";
    case "init": return "docs.init";
    case "new": return "docs.new";
    case "recover": return "docs.recover";
    case undefined:
    default: return "docs.info";
  }
}

async function dispatchFind(protocol: DocsProtocol, args: Arguments, options: CommonArguments) {
  const query = parseFindQuery(args);
  const execution = query.ranking === "fuzzy-advisory"
    ? await protocol.findV3({ ...options, query })
    : await protocol.findV2({ ...options, query });
  return { execution, json: options.json };
}

function parseFindQuery(args: Arguments): DocsFindQueryV3 {
  const explicitText = args.one("--text");
  const id = args.one("--id");
  const type = args.one("--type");
  const status = args.one("--status");
  const owner = args.one("--owner");
  const related = args.one("--related");
  const blockedBy = args.one("--blocked-by");
  const fuzzy = args.flag("--fuzzy");
  const positionals = args.positionals();
  if (positionals.length > 1 || (positionals.length === 1 && explicitText !== undefined)) {
    throw new CliInputError("Supply search text once, positionally or with --text.");
  }
  const text = explicitText ?? positionals[0];
  const query: DocsFindQueryV3 = {
    ...(text === undefined ? {} : { text }),
    ...(id === undefined ? {} : { id }),
    ...(type === undefined ? {} : { type }),
    ...(status === undefined ? {} : { status }),
    ...(owner === undefined ? {} : { owner }),
    ...(related === undefined ? {} : { related }),
    ...(blockedBy === undefined ? {} : { blockedBy }),
    ...(fuzzy ? { ranking: "fuzzy-advisory" as const } : {})
  };
  return query;
}

function boundedInteger(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number
): number | undefined {
  if (value === undefined) {return undefined;}
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {throw new CliInputError(`${name} must be a non-negative integer.`);}
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CliInputError(`${name} must be an integer from ${String(minimum)} through ${String(maximum)}.`);
  }
  return parsed;
}

async function dispatchContext(protocol: DocsProtocol, args: Arguments, options: CommonArguments) {
  const maxDocuments = boundedInteger(
    args.one("--max-documents"),
    "--max-documents",
    0,
    MAXIMUM_COMMUNITY_CONTEXT_DOCUMENTS
  );
  const maxBytes = boundedInteger(
    args.one("--max-bytes"),
    "--max-bytes",
    MINIMUM_COMMUNITY_CONTEXT_BYTES,
    MAXIMUM_COMMUNITY_CONTEXT_BYTES
  );
  const query = parseFindQuery(args);
  return {
    execution: await protocol.contextV1({
      ...options,
      query,
      ...(maxDocuments === undefined && maxBytes === undefined
        ? {}
        : { limits: {
            ...(maxDocuments === undefined ? {} : { maxDocuments }),
            ...(maxBytes === undefined ? {} : { maxBytes })
          } })
    }),
    json: options.json
  };
}

function assertInitPlanArguments(input: {
  readonly apply: boolean;
  readonly dryRun: boolean;
  readonly expectedPlanDigest: string | undefined;
  readonly ownerId: string | undefined;
  readonly projectId: string | undefined;
}): asserts input is typeof input & {
  readonly ownerId: string;
  readonly projectId: string;
} {
  if (input.dryRun === input.apply) {throw new CliInputError("Exactly one of --dry-run or --apply is required.");}
  if (input.projectId === undefined) {throw new CliInputError("--project-id is required.");}
  if (input.ownerId === undefined) {throw new CliInputError("--owner is required.");}
  if (input.dryRun && input.expectedPlanDigest !== undefined) {throw new CliInputError("--expect is valid only with --apply.");}
  if (input.apply && input.expectedPlanDigest === undefined) {throw new CliInputError("--apply requires the exact --expect digest returned by --dry-run.");}
}

async function dispatchInit(args: Arguments, signal: AbortSignal) {
  const consumerRoot = args.one("--consumer") ?? ".";
  const json = args.flag("--json");
  const recover = args.flag("--recover");
  const dryRun = args.flag("--dry-run");
  const apply = args.flag("--apply");
  const projectId = args.one("--project-id");
  const ownerId = args.one("--owner");
  const expectedPlanDigest = args.one("--expect");
  if (args.positionals().length !== 0) {throw new CliInputError("Unknown docs:init arguments.");}
  signal.throwIfAborted();
  if (recover) {
    if (dryRun || apply || projectId !== undefined || ownerId !== undefined || expectedPlanDigest !== undefined) {
      throw new CliInputError("--recover cannot be combined with bootstrap planning arguments.");
    }
    return dispatchInitRecovery(consumerRoot, json);
  }
  const planArguments = { apply, dryRun, expectedPlanDigest, ownerId, projectId };
  assertInitPlanArguments(planArguments);
  if (apply) {
    const barrier = await docsInitApplyPreflight({ consumerRoot });
    if (barrier !== undefined) {return dispatchInitBarrier(barrier, json);}
  }
  const plan = await docsInitPlan({
    consumerRoot,
    projectId: planArguments.projectId,
    ownerId: planArguments.ownerId
  });
  if (plan.writeState === "blocked") {
    return {
      json,
      execution: directExecution("docs.init", "conflict", plan, plan.issues.map((issue) => ({
        ruleId: "docs.init.bootstrap-conflict",
        severity: "error" as const,
        phase: "planning" as const,
        subject: issue.path,
        message: issue.message
      })))
    };
  }
  if (!apply) {return { json, execution: directExecution("docs.init", "success", plan) };}
  if (planArguments.expectedPlanDigest !== plan.planDigest) {
    return {
      json,
      execution: directExecution("docs.init", "authority-stale", plan, [{
        ruleId: "docs.init.plan-stale",
        severity: "error",
        phase: "planning",
        subject: "--expect",
        message: "Portable bootstrap authority changed after preview; review a fresh dry run."
      }])
    };
  }
  const applied = await docsInitApply({
    consumerRoot,
    projectId: planArguments.projectId,
    ownerId: planArguments.ownerId,
    expectedPlanDigest: plan.planDigest
  });
  if (applied.writeState === "blocked") {
    return dispatchInitBarrier(applied, json);
  }
  return {
    json,
    execution: directExecution("docs.init", "success", applied)
  };
}

function dispatchInitBarrier(
  barrier:
    | { readonly kind: "init"; readonly operation: "recover"; readonly writeState: "blocked"; readonly message: string }
    | { readonly kind: "init"; readonly operation: "wait"; readonly writeState: "blocked"; readonly reason: "operation-active"; readonly message: string },
  json: boolean
) {
  if (barrier.operation === "wait") {
    return {
      json,
      execution: directExecution("docs.init", "conflict", Object.freeze({
        kind: barrier.kind,
        operation: barrier.operation,
        writeState: barrier.writeState,
        reason: barrier.reason
      }), [{
        ruleId: "docs.init.operation-active",
        severity: "error",
        phase: "planning",
        subject: "foundation.operation",
        message: barrier.message
      }])
    };
  }
  return {
    json,
    execution: directExecution("docs.init", "recovery-required", Object.freeze({
      kind: barrier.kind,
      operation: barrier.operation,
      writeState: barrier.writeState
    }), [{
      ruleId: "docs.init.apply-recovery-required",
      severity: "error",
      phase: "recovery",
      subject: "foundation.transaction",
      message: barrier.message
    }])
  };
}

async function dispatchInitRecovery(consumerRoot: string, json: boolean) {
  const recovery = await docsInitRecover({ consumerRoot });
  if (recovery.writeState === "unchanged") {
    return { json, execution: directExecution("docs.init", "success", recovery) };
  }
  if (recovery.writeState === "blocked") {
    if (recovery.operation === "wait") {return dispatchInitBarrier(recovery, json);}
    return {
      json,
      execution: directExecution("docs.init", "recovery-required", Object.freeze({
        kind: recovery.kind,
        operation: recovery.operation,
        writeState: recovery.writeState
      }), [{
        ruleId: "docs.init.recovery-blocked",
        severity: "error",
        phase: "recovery",
        subject: "foundation.transaction",
        message: recovery.message
      }])
    };
  }
  return { json, execution: directExecution("docs.init", "success", recovery) };
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
    execution: await protocol.newDocumentV2({
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

async function dispatch(protocol: DocsProtocol, command: string, values: readonly string[], signal: AbortSignal): Promise<{ readonly execution: DocsMachineExecution; readonly json: boolean }> {
  const args = new Arguments(values);
  if (command === "init") {return dispatchInit(args, signal);}
  if (!["info", "find", "context", "new", "doctor", "recover", "check"].includes(command)) {
    throw new CliInputError("Expected one command: info, find, context, new, doctor, recover, check, or init.");
  }
  const options = await common(args, signal);
  if (command === "info") {
    if (args.positionals().length !== 0) {throw new CliInputError("docs:info accepts no positional arguments.");}
    return { execution: await protocol.infoV2(options), json: options.json };
  }
  if (command === "find") {
    return dispatchFind(protocol, args, options);
  }
  if (command === "context") {
    return dispatchContext(protocol, args, options);
  }
  if (command === "new") {
    return dispatchNew(protocol, args, options);
  }
  if (command === "doctor") {
    if (args.positionals().length !== 0) {throw new CliInputError("docs:doctor accepts no positional arguments.");}
    return { execution: await protocol.doctorV2(options), json: options.json };
  }
  if (command === "recover") {
    if (args.positionals().length !== 0) {throw new CliInputError("docs:recover accepts no positional arguments.");}
    return { execution: await protocol.recoverV2(options), json: options.json };
  }
  if (command === "check") {
    if (args.positionals().length !== 0) {throw new CliInputError("docs:check accepts no positional arguments.");}
    return { execution: await protocol.checkV2(options), json: options.json };
  }
  throw new CliInputError("Documentation command routing is incomplete.");
}

function helpText(command?: string): string {
  if (command === "init") {
    return "Usage: docs-protocol init --project-id ID --owner OWNER (--dry-run|--apply --expect sha256:DIGEST) [--consumer PATH] [--json]\n       docs-protocol init --recover [--consumer PATH] [--json]\n";
  }
  if (command === "new") {
    return "Usage: agent-teams-docs new --type TYPE --id ID --title TITLE --owner OWNER --summary SUMMARY (--dry-run|--apply) [--slug SLUG] [--destination PATH] [--related ID] [--blocked-by ID] [--code-anchor required:PATTERN|JSON] [--metadata key=JSON]\nRepeat --related, --blocked-by, --code-anchor, and --metadata as needed. Preview returns exact compiled document/frontmatter/metadata/relations/anchors.\n";
  }
  if (command === "find") {
    return "Usage: docs-protocol find [TEXT|--text TEXT] [--fuzzy] [--id ID] [--type TYPE] [--status STATUS] [--owner OWNER] [--related ID] [--blocked-by ID] [--consumer PATH] [--profile PATH] [--json]\n";
  }
  if (command === "context") {
    return "Usage: docs-protocol context [TEXT|--text TEXT] [--fuzzy] [--id ID] [--type TYPE] [--status STATUS] [--owner OWNER] [--related ID] [--blocked-by ID] [--max-documents N] [--max-bytes N] [--consumer PATH] [--profile PATH] [--json]\n";
  }
  if (["info", "doctor", "recover", "check"].includes(command ?? "")) {
    return `Usage: agent-teams-docs ${command} [--consumer PATH] [--profile PATH] [--json]\n`;
  }
  return "Usage: agent-teams-docs <info|find|context|new|doctor|recover|check|init> [options]\nThe package also installs the package-manager-neutral 'docs-protocol' alias. Managed Agent Teams operations are available only from the separate adapter package and its 'agent-teams-docs-managed' executable.\n";
}

export function runDocsCli(argv: readonly string[]): Promise<number>;
export async function runDocsCli(
  argv: readonly string[],
  protocolFactory: () => DocsProtocol = () => new DocsProtocol({
    adoption: new NodeDocsAdoptionInspector(),
    anchors: new NodeCodeAnchorMatcher(),
    foundation: new NodeDocumentAuthoringPort(),
    profiles: new NodeDocsProfileReader()
  })
): Promise<number> {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
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
  const requestedEnvelopeVersion = id === "docs.find" && normalizedArgv.includes("--fuzzy")
    ? 3
    : commandEnvelopeVersion(id);
  let execution: DocsMachineExecution;
  try {
    const dispatched = await dispatch(protocolFactory(), command ?? "", normalizedArgv.slice(1), controller.signal);
    execution = dispatched.execution;
    json = dispatched.json;
  } catch (error) {
    execution = docsCliErrorExecution(id, error, json, requestedEnvelopeVersion);
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
  if (json) {
    execution = await validatedMachineExecution(id, execution);
  }
  process.stdout.write(json
    ? `${JSON.stringify(execution.envelope)}\n`
    : execution.envelope.schemaVersion === 3
      ? renderDocsHumanV3(execution.envelope)
      : renderDocsHumanV2(execution.envelope));
  return execution.exitCode;
}
