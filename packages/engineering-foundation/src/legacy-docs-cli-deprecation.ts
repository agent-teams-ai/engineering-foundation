export const LEGACY_DOCS_CLI_DEPRECATION_CODE =
  "FOUNDATION_DOCS_CLI_DEPRECATED";
export const LEGACY_DOCS_CLI_COMMAND = "agent-teams-foundation docs";
export const DOCS_PROTOCOL_CLI_COMMAND = "agent-teams-docs";
export const DOCS_PROTOCOL_PACKAGE_NAME = ["@agent-teams", "docs-protocol"].join(
  "/"
);

function requestsJson(rawArguments: readonly string[]): boolean {
  return rawArguments.includes("--json") || rawArguments.some(
    (argument, index) =>
      argument === "--format" && rawArguments[index + 1] === "json"
  );
}

export function isLegacyDocsCliInvocation(
  rawArguments: readonly string[]
): boolean {
  return rawArguments[0] === "docs";
}

export function renderLegacyDocsCliDeprecation(
  rawArguments: readonly string[],
  machineOutput = requestsJson(rawArguments)
): string | undefined {
  if (!isLegacyDocsCliInvocation(rawArguments)) {
    return undefined;
  }
  if (machineOutput) {
    // The published legacy machine contract reserves stderr for launcher
    // failures and requires exactly one command envelope on stdout.
    return undefined;
  }
  return `${LEGACY_DOCS_CLI_DEPRECATION_CODE}: ${LEGACY_DOCS_CLI_COMMAND} is deprecated and frozen for compatibility. Use ${DOCS_PROTOCOL_CLI_COMMAND} from ${DOCS_PROTOCOL_PACKAGE_NAME}.\n`;
}

export function emitLegacyDocsCliDeprecation(
  rawArguments: readonly string[],
  options: {
    readonly machineOutput?: boolean;
    readonly write?: (notice: string) => void;
  } = {}
): void {
  const notice = renderLegacyDocsCliDeprecation(
    rawArguments,
    options.machineOutput ?? requestsJson(rawArguments)
  );
  if (notice !== undefined) {
    (options.write ?? ((value) => process.stderr.write(value)))(notice);
  }
}
