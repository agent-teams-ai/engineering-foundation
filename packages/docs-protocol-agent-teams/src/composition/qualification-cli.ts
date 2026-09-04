import {
  DOCS_PROTOCOL_ID,
  DOCS_PROTOCOL_VERSION
} from "@agent-teams/docs-protocol";

import { readManagedQualificationProfileInput } from
  "../consumer-integration/composition/qualification-v3-boundary.js";
import {
  assertManagedQualificationEnvelopeSchema,
  type ManagedQualificationEnvelope
} from "../qualification/managed-command-envelope-validator.js";
import {
  runDocsProtocolQualificationV2,
  type DocsProtocolQualificationReceiptV2
} from "../qualification/index.js";
import { Arguments, CliInputError } from "./managed-cli-input.js";

class QualificationOutputError extends Error {
  constructor() {
    super("Documentation qualification produced invalid output.");
    this.name = "QualificationOutputError";
  }
}

interface QualificationFailure {
  readonly envelope: ManagedQualificationEnvelope<Readonly<Record<string, never>>>;
  readonly exitCode: 1 | 2 | 3 | 130;
  readonly message: string;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function violationRuleId(message: string): string {
  return message.startsWith("DOCS_QUALIFICATION_V1_MIGRATION_REQUIRED")
    ? "docs.qualification.v1-migration-required"
    : "docs.qualification.violation";
}

function qualificationFailure(error: unknown): QualificationFailure {
  const message = (error instanceof Error ? error.message : "Qualification failed.").slice(0, 1000);
  const cancelled = error instanceof Error && error.name === "AbortError";
  const code = errorCode(error);
  const invalidOutput = error instanceof QualificationOutputError;
  const inputInvalid = !invalidOutput && (error instanceof CliInputError || error instanceof SyntaxError || error instanceof TypeError);
  const operational = code !== undefined && /^(?:EACCES|EISDIR|ELOOP|EMFILE|ENAMETOOLONG|ENOENT|ENOSPC|ENOTDIR|EPERM|EROFS)$/u.test(code);
  const outcome = cancelled ? "cancelled" as const
    : inputInvalid ? "invalid-input" as const
      : operational || invalidOutput ? "execution-failure" as const
        : "violation" as const;
  const exitCode = cancelled ? 130 as const : inputInvalid ? 2 as const : operational || invalidOutput ? 3 as const : 1 as const;
  const ruleId = cancelled ? "docs.qualification.cancelled"
    : inputInvalid ? "docs.qualification.invalid-input"
      : operational ? "docs.qualification.execution-failure.filesystem"
        : invalidOutput ? "docs.qualification.execution-failure.internal"
          : violationRuleId(message);
  return {
    exitCode,
    message,
    envelope: {
      schemaVersion: 2,
      protocol: { id: DOCS_PROTOCOL_ID, version: DOCS_PROTOCOL_VERSION },
      command: "docs.qualify",
      outcome,
      diagnostics: [{ ruleId, severity: "error", phase: inputInvalid ? "input" : "authority", subject: "docs.qualify", message }],
      result: Object.freeze({})
    }
  };
}

function qualificationHelpText(): string {
  return "Usage: agent-teams-docs-managed qualify [--consumer PATH] [--integration PATH] [--local-development] [--json]\nProfiles v1/v2 run the adapter-owned suite in a disposable copy. Profile v3 requires a trusted registry/canary receipt produced outside this consumer CLI. The declared consumer gate is never executed. --local-development applies only to profiles v1/v2 and emits evidence that is not cohort-admissible.\n";
}

async function qualificationSuccess(
  args: Arguments,
  signal: AbortSignal
): Promise<{
  readonly envelope: ManagedQualificationEnvelope<DocsProtocolQualificationReceiptV2>;
  readonly exitCode: 0;
}> {
  const localDevelopment = args.flag("--local-development");
  const consumerRoot = args.one("--consumer") ?? ".";
  const integrationPath = args.one("--integration") ??
    "architecture/foundation/docs-consumer-integration.json";
  if (args.positionals().length !== 0) {throw new CliInputError("qualify accepts no positional arguments.");}
  const input = await readManagedQualificationProfileInput(consumerRoot, integrationPath);
  const integration = input.profile;
  if (integration.schemaVersion !== 1 && integration.schemaVersion !== 2 &&
    integration.schemaVersion !== 3) {
    throw new CliInputError("Managed qualification requires explicit integration profile schemaVersion 1, 2, or 3.");
  }
  if (integration.schemaVersion === 3) {
    throw new CliInputError(
      "Qualification profile v3 requires a trusted registry/canary receipt produced outside the consumer CLI."
    );
  }
  const receipt = await runDocsProtocolQualificationV2({
    consumerRoot: input.consumerRoot,
    localDevelopment,
    signal,
    integrationPath
  });
  return {
    exitCode: 0,
    envelope: {
      schemaVersion: 2,
      protocol: { id: DOCS_PROTOCOL_ID, version: DOCS_PROTOCOL_VERSION },
      command: "docs.qualify",
      outcome: "success",
      diagnostics: [],
      result: receipt
    }
  };
}

function renderQualificationSuccess(
  execution: { readonly envelope: ManagedQualificationEnvelope<DocsProtocolQualificationReceiptV2> },
  json: boolean
): string {
  if (json) {return `${JSON.stringify(execution.envelope)}\n`;}
  const receipt = execution.envelope.result;
  return `docs.qualify: success\nProject: ${receipt.projectId}\nScenarios: ${receipt.scenarios.length}\nEvidence: ${receipt.evidenceClass}\n`;
}

export async function runQualificationCli(values: readonly string[]): Promise<number> {
  if (values.length === 1 && values[0] === "--help") {
    process.stdout.write(qualificationHelpText());
    return 0;
  }
  const controller = new AbortController();
  const cancel = () => { controller.abort(new DOMException("Documentation qualification was cancelled.", "AbortError")); };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let json = values.includes("--json");
  try {
    const args = new Arguments(values);
    json = args.flag("--json");
    const execution = await qualificationSuccess(args, controller.signal);
    if (json) {
      try {await assertManagedQualificationEnvelopeSchema(execution.envelope);}
      catch {throw new QualificationOutputError();}
    }
    process.stdout.write(renderQualificationSuccess(execution, json));
    return 0;
  } catch (error) {
    const failure = qualificationFailure(error);
    if (json) {await assertManagedQualificationEnvelopeSchema(failure.envelope);}
    process.stdout.write(json ? `${JSON.stringify(failure.envelope)}\n` : `docs.qualify: ${failure.envelope.outcome}\n${failure.message}\n`);
    return failure.exitCode;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
