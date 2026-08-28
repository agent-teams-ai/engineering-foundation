import { createRequire } from "node:module";

const manifest: unknown = createRequire(import.meta.url)("../package.json");
const packageVersion = typeof manifest === "object" && manifest !== null && "version" in manifest
  ? manifest.version
  : undefined;

if (typeof packageVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(packageVersion)) {
  throw new Error("@agent-teams/docs-protocol-mcp package.json must contain a semantic version.");
}

export const DOCS_PROTOCOL_MCP_PACKAGE_VERSION: string = packageVersion;
export const DOCS_PROTOCOL_MCP_PROJECTION_VERSION = 1 as const;
