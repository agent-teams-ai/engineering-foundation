import type { ParsedArguments } from "./cli-arguments.js";
import {
  renderDocumentFindText,
  runDocumentFindCommand
} from "./document-authoring/find-command.js";

export async function runDocumentCommand(
  parsed: ParsedArguments,
  json: boolean
): Promise<boolean> {
  if (parsed.command !== "docs.find") {
    return false;
  }
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
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
