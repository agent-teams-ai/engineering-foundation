import { readFileSync } from "node:fs";

const manifest: unknown = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"));
const packageVersion = typeof manifest === "object" && manifest !== null && "version" in manifest
  ? manifest.version
  : undefined;

if (typeof packageVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(packageVersion)) {
  throw new Error("@agent-teams/docs-protocol-mcp package.json must contain a semantic version.");
}

export const DOCS_PROTOCOL_MCP_PACKAGE_VERSION: string = packageVersion;
