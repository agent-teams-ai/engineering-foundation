import type { ParsedArguments } from "./cli-arguments.js";
import {
  renderDocumentFindText,
  runDocumentFindCommand
} from "./document-authoring/find-command.js";
import {
  createNodeDocumentCommands,
  renderDocumentCommandJson,
  renderDocumentCommandText
} from "./document-authoring/composition/document-command-cli.js";

function signalOption(signal: AbortSignal | undefined): {
  readonly signal?: AbortSignal;
} {
  return signal === undefined ? {} : { signal };
}

function requiredDocumentIntent(parsed: ParsedArguments): {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly owner: string;
  readonly summary: string;
  readonly title: string;
  readonly type: string;
  readonly destination?: string;
  readonly related?: readonly string[];
  readonly slug?: string;
} {
  if (
    parsed.documentId === undefined ||
    parsed.documentOwner === undefined ||
    parsed.documentSummary === undefined ||
    parsed.documentTitle === undefined ||
    parsed.documentType === undefined
  ) {
    throw new Error("Validated docs new arguments are incomplete.");
  }
  return {
    schemaVersion: 1,
    id: parsed.documentId,
    owner: parsed.documentOwner,
    summary: parsed.documentSummary,
    title: parsed.documentTitle,
    type: parsed.documentType,
    ...(parsed.documentDestination === undefined
      ? {} : { destination: parsed.documentDestination }),
    ...(parsed.documentRelated.length === 0
      ? {} : { related: parsed.documentRelated }),
    ...(parsed.documentSlug === undefined ? {} : { slug: parsed.documentSlug })
  };
}

type NodeDocumentCommands = ReturnType<typeof createNodeDocumentCommands>;

export interface DocumentCommandComposition {
  readonly doctor: Pick<NodeDocumentCommands["doctor"], "execute">;
  readonly newDocument: Pick<NodeDocumentCommands["newDocument"], "execute">;
  readonly recover: Pick<NodeDocumentCommands["recover"], "execute">;
}

async function runDocumentMutation(
  parsed: ParsedArguments,
  signal: AbortSignal,
  commands: DocumentCommandComposition
) {
  switch (parsed.command) {
    case "docs.new":
      return commands.newDocument.execute({
        consumerRoot: parsed.consumerRoot,
        profilePath: parsed.documentProfilePath,
        intent: requiredDocumentIntent(parsed),
        dryRun: parsed.documentDryRun,
        ...signalOption(signal)
      });
    case "docs.doctor":
      return commands.doctor.execute({
        consumerRoot: parsed.consumerRoot,
        ...signalOption(signal)
      });
    case "docs.recover":
      return commands.recover.execute({
        consumerRoot: parsed.consumerRoot,
        ...signalOption(signal)
      });
    default:
      return null;
  }
}

export async function runDocumentCommand(
  parsed: ParsedArguments,
  json: boolean
): Promise<boolean> {
  return runDocumentCommandWithComposition(
    parsed,
    json,
    createNodeDocumentCommands
  );
}

export async function runDocumentCommandWithComposition(
  parsed: ParsedArguments,
  json: boolean,
  createCommands: () => DocumentCommandComposition
): Promise<boolean> {
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (parsed.command !== "docs.find") {
      const execution = await runDocumentMutation(
        parsed,
        controller.signal,
        createCommands()
      );
      if (execution === null) {
        return false;
      }
      process.stdout.write(json
        ? renderDocumentCommandJson(execution)
        : renderDocumentCommandText(execution));
      process.exitCode = execution.exitCode;
      return true;
    }
    const result = await runDocumentFindCommand({
      consumerRoot: parsed.consumerRoot,
      filters: {
        ...(parsed.documentId === undefined ? {} : { id: parsed.documentId }),
        ...(parsed.documentOwner === undefined
          ? {}
          : { owner: parsed.documentOwner }),
        ...(parsed.documentStatus === undefined
          ? {}
          : { status: parsed.documentStatus }),
        ...(parsed.documentType === undefined
          ? {}
          : { type: parsed.documentType })
      },
      profilePath: parsed.documentProfilePath,
      signal: controller.signal,
      ...(parsed.positional[0] === undefined
        ? {}
        : { text: parsed.positional[0] })
    });
    process.stdout.write(
      json
        ? `${JSON.stringify(result.envelope)}\n`
        : renderDocumentFindText(result)
    );
    process.exitCode = result.exitCode;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
  return true;
}
