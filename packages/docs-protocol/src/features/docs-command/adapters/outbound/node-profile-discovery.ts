export const PORTABLE_DOCS_PROFILE_PATH = "docs.config.yaml";

export async function discoverDocsProfilePath(input: {
  readonly consumerRoot: string;
  readonly explicitProfilePath?: string;
}): Promise<string> {
  if (input.explicitProfilePath !== undefined) {return input.explicitProfilePath;}
  return PORTABLE_DOCS_PROFILE_PATH;
}
