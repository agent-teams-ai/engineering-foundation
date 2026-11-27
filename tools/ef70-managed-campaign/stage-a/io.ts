import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  assertCampaignRoot,
  observationChildEnvironment,
  observationHeaders,
  ownedDirectory,
} from "../owned-root.ts";

export type JsonRecord = Record<string, unknown>;
export const outputRoot = requireEnvironment("EF_CAMPAIGN_OUTPUT");
const campaign = assertCampaignRoot();
if (
  !isAbsolute(outputRoot) ||
  resolve(outputRoot) !== outputRoot ||
  !outputRoot.startsWith(campaign.evidenceRoot + sep)
) {
  throw new Error("Output must be inside the owned external evidence root.");
}
ownedDirectory(dirname(outputRoot));
mkdirSync(outputRoot, { recursive: false, mode: 0o700 });
let commandIndex = 0;

export function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value || /[\r\n\0]/u.test(value)) {
    throw new Error(`Missing or malformed environment ${name}.`);
  }
  return value;
}
export function object(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as JsonRecord;
}
export function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
}
export function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}
export function requireEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} differs from its exact selection.`);
  }
}
export function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
export function utf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
export function parse(source: string, label: string): JsonRecord {
  const value: unknown = JSON.parse(source);
  return object(value, label);
}
export function evidence(path: string, bytes: Uint8Array | string): void {
  const destination = resolve(outputRoot, path);
  if (isAbsolute(path) || !destination.startsWith(`${resolve(outputRoot)}${sep}`)) {
    throw new Error("Evidence path escapes its owned root.");
  }
  const slash = destination.lastIndexOf(sep);
  mkdirSync(destination.slice(0, slash), { recursive: true });
  writeFileSync(destination, bytes, { flag: "wx" });
}
export function jsonEvidence(path: string, value: unknown): void {
  evidence(path, `${JSON.stringify(value, null, 2)}\n`);
}
export interface CommandResult {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}
export interface CommandOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly accepted?: readonly number[];
}
export function command(
  label: string,
  executable: string,
  arguments_: readonly string[],
  cwd: string,
  options: CommandOptions = {},
): CommandResult {
  const { environment = process.env, accepted = [0] } = options;
  if (!/^[a-z0-9-]+$/u.test(label) || !isAbsolute(executable) || !isAbsolute(cwd)) {
    throw new Error("Command label, executable and cwd must be explicitly bounded.");
  }
  const index = ++commandIndex;
  const result = spawnSync(executable, arguments_, {
    cwd,
    env: observationChildEnvironment(environment),
    timeout: 15 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = result.stdout ?? Buffer.alloc(0),
    stderr = result.stderr ?? Buffer.alloc(0);
  evidence(`commands/${index}-${label}.stdout`, stdout);
  evidence(`commands/${index}-${label}.stderr`, stderr);
  jsonEvidence(`commands/${index}-${label}.json`, {
    executable,
    arguments: arguments_,
    cwd,
    status: result.status,
    signal: result.signal,
    stdoutDigest: digest(stdout),
    stderrDigest: digest(stderr),
    error: result.error?.message ?? null,
  });
  if (result.error || result.status === null || !accepted.includes(result.status)) {
    throw new Error(`Command ${index} (${label}) did not satisfy its selected exit contract.`);
  }
  return { status: result.status, stdout, stderr };
}
export async function fetchBytes(url: string, maximum = 8 * 1024 * 1024): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("Only credential-free HTTPS observations are supported.");
  }
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: observationHeaders(parsed),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`Observation failed: HTTP ${response.status}.`);
  }
  const chunks: Uint8Array[] = [];
  let count = 0;
  for await (const chunk of response.body) {
    count += chunk.byteLength;
    if (count > maximum) {
      throw new Error("Observation exceeded its explicit byte bound.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function transport(paths: readonly string[]): void {
  let total = 0;
  const entries = paths.map((path) => {
    const bytes = readFileSync(join(outputRoot, path));
    total += bytes.byteLength;
    if (bytes.byteLength > 2 * 1024 * 1024 || total > 6 * 1024 * 1024) {
      throw new Error("API transport exceeded its bounded artifact selection.");
    }
    return {
      path,
      mode: "100644",
      bytes: bytes.byteLength,
      sha256: digest(bytes),
      content: bytes.toString("base64"),
    };
  });
  const manifest = entries.map((entry) => ({
    path: entry.path,
    mode: entry.mode,
    bytes: entry.bytes,
    sha256: entry.sha256,
  }));
  const manifestSource = `${JSON.stringify(manifest)}\n`;
  console.log(
    `EF_OUTPUT_MANIFEST ${JSON.stringify({ sha256: digest(manifestSource), entries: manifest })}`,
  );
  for (const entry of entries) {
    const count = Math.ceil(entry.content.length / 12_000);
    for (let part = 0; part < count; part += 1) {
      console.log(
        `EF_OUTPUT_CHUNK ${JSON.stringify({
          path: entry.path,
          sha256: entry.sha256,
          part,
          count,
          base64: entry.content.slice(part * 12_000, (part + 1) * 12_000),
        })}`,
      );
    }
  }
  appendFileSync(join(outputRoot, "transport-manifest.json"), manifestSource, { flag: "wx" });
}
