import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runCommand } from "./pack-test-support.mjs";
import type { QualifiedArchiveRecord } from "./package-artifact-custody.mts";
import type { ConsumerIntegrationDigest } from "../packages/docs-protocol-agent-teams/dist/consumer-integration/domain/model.js";

export interface PackedDocsArchive extends QualifiedArchiveRecord {
  readonly archiveFileSpecifier: string;
}

export type PackedDocsPnpmRunner = (args: readonly string[], cwd: string) => Promise<unknown>;

export function docsFixtureRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

export function docsFixtureText(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

export function docsFixtureDigest(bytes: Uint8Array): ConsumerIntegrationDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Preserve the existing bounded command owner and validate only its returned streams. */
export async function runPackedDocsCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const value: unknown = await runCommand(command, [...args], cwd);
  const result = docsFixtureRecord(value);
  return { stdout: docsFixtureText(result["stdout"]), stderr: docsFixtureText(result["stderr"]) };
}

export function parseDocsExecution(stdout: string): Record<string, unknown> {
  if (stdout.trim() === "") {
    throw new Error("Packed Docs Protocol CLI returned no JSON output.");
  }
  const value: unknown = JSON.parse(stdout);
  return docsFixtureRecord(value);
}

/** These functions are loaded from the admitted installed archive, never producer source. */
export function installedDocsTextCall(
  api: Record<string, unknown>,
  name: string,
  args: readonly unknown[],
): string {
  const method = api[name];
  assert.ok(typeof method === "function");
  const result: unknown = Reflect.apply(method, api, args);
  return docsFixtureText(result);
}

export function installedDocsDigestCall(
  api: Record<string, unknown>,
  name: string,
  args: readonly unknown[],
): ConsumerIntegrationDigest {
  const result = installedDocsTextCall(api, name, args);
  assert.ok(isDigest(result));
  return result;
}

function isDigest(value: string): value is ConsumerIntegrationDigest {
  return /^sha256:[a-f0-9]{64}$/u.test(value);
}
