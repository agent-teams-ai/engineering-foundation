import type { CommandInvocation } from "./command-invocation.js";
import type { FoundationCommandServices } from "./command-services.js";
import { invalidCommand } from "./command-reporting.js";

export type InformationCommand =
  | { readonly command: "help" | "version" | "self-check" }
  | { readonly command: "schema"; readonly schemaId: string };

export function admitInformationCommand(input: CommandInvocation): InformationCommand | undefined {
  switch (input.command) {
    case "help":
    case "--help":
    case "-h":
      if (input.format === "json") {
        throw invalidCommand("--json is not accepted by help.");
      }
      return { command: "help" };
    case "version":
    case "--version":
    case "-v":
      if (input.format === "json") {
        throw invalidCommand("--json is not accepted by version.");
      }
      return { command: "version" };
    case "self-check":
      return { command: "self-check" };
    case "schema": {
      const schemaId = input.positional[0];
      if (schemaId === undefined) {
        throw invalidCommand("Unknown schema ID: missing.");
      }
      return { command: "schema", schemaId };
    }
    default:
      return undefined;
  }
}

export type InformationCommandResult =
  | { readonly kind: "help" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "package"; readonly result: unknown };

export async function executeInformationCommand<SchemaId extends string>(
  services: Pick<
    FoundationCommandServices<SchemaId>,
    "inspectPackage" | "installedVersion" | "isSchemaId" | "readSchema"
  >,
  input: InformationCommand,
): Promise<InformationCommandResult> {
  switch (input.command) {
    case "help":
      return { kind: "help" };
    case "version":
      return { kind: "text", text: `${await services.installedVersion()}\n` };
    case "self-check":
      return { kind: "package", result: await services.inspectPackage() };
    case "schema":
      if (!services.isSchemaId(input.schemaId)) {
        throw invalidCommand(`Unknown schema ID: ${input.schemaId}.`);
      }
      return { kind: "text", text: await services.readSchema(input.schemaId) };
  }
}
