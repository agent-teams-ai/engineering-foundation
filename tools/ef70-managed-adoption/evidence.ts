import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { executeCommand, row, type Row } from "../ef70-managed-campaign/campaign-io.ts";
import { observationHeaders } from "../ef70-managed-campaign/owned-root.ts";
import type { AdoptionConfig } from "./configuration.ts";
import { inventory, retainAt, selected, sha256 } from "./files.ts";

export interface CommandOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}
export class AdoptionEvidence {
  readonly config: AdoptionConfig;
  readonly rawRoot: string;
  readonly operationRoot: string;
  private sequence = 0;
  constructor(config: AdoptionConfig) {
    this.config = config;
    this.rawRoot = join(config.roots.evidenceRoot, "bootstrap");
    this.operationRoot = join(config.roots.evidenceRoot, "case-canonical");
    this.retain(
      "prerequisite-generation.json",
      readFileSync(join(config.roots.root, "prerequisite-generation.json")),
    );
  }
  retain(name: string, content: Uint8Array | string): string {
    return retainAt(this.rawRoot, name, content);
  }
  record(name: string, value: unknown): string {
    assert(/^[a-z0-9][a-z0-9.-]*$/u.test(name));
    return this.retain(name + ".json", JSON.stringify(value, null, 2) + "\n");
  }
  command(
    label: string,
    executable: string,
    args: readonly string[],
    cwd: string,
    options: CommandOptions = {},
  ): Buffer {
    const stem = join(this.rawRoot, String(++this.sequence) + "-" + label);
    return executeCommand({
      label,
      executable,
      args,
      cwd,
      observer: false,
      accepted: [0],
      stem,
      environment: options.environment ?? this.config.environment,
      timeoutMs: options.timeoutMs ?? 960_000,
    }).stdout;
  }
  git(root: string, label: string, args: readonly string[]): string {
    return this.command(label, "/usr/bin/git", ["--no-replace-objects", ...args], root)
      .toString("utf8")
      .trimEnd();
  }
  async fetchObserved(url: string, label: string, maximum = 8 * 1024 * 1024): Promise<Buffer> {
    const parsed = new URL(url);
    assert(parsed.protocol === "https:" && !parsed.username && !parsed.password);
    assert(
      parsed.origin === "https://registry.npmjs.org" ||
        (parsed.origin === "https://api.github.com" &&
          parsed.pathname.startsWith("/repos/agent-teams-ai/")),
    );
    const response = await fetch(parsed, {
      headers: observationHeaders(parsed),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    const chunks: Uint8Array[] = [];
    let count = 0;
    if (response.body !== null) {
      for await (const chunk of response.body) {
        count += chunk.byteLength;
        assert(count <= maximum, "Observation exceeds byte bound");
        chunks.push(chunk);
      }
    }
    const body = Buffer.concat(chunks);
    this.retain(label + ".raw", body);
    this.record(label + "-transport", {
      url: parsed.href,
      observedAt: new Date().toISOString(),
      status: response.status,
      bytes: body.length,
      sha256: sha256(body),
      requestId: response.headers.get("x-github-request-id"),
      remaining: response.headers.get("x-ratelimit-remaining"),
      reset: response.headers.get("x-ratelimit-reset"),
    });
    assert(response.ok && response.body !== null, "Observation failed: " + label);
    return body;
  }
  async github(path: string, label: string): Promise<Row> {
    return row(
      JSON.parse(
        (
          await this.fetchObserved("https://api.github.com/repos/agent-teams-ai/" + path, label)
        ).toString("utf8"),
      ),
      label,
    );
  }
  output(name: string, value: unknown): string {
    const path = retainAt(
      this.config.roots.evidenceRoot,
      name + ".json",
      JSON.stringify(value, null, 2) + "\n",
    );
    return path;
  }
  snapshot(label: string, root = this.config.consumer) {
    const observed = inventory(root);
    this.record(label, observed);
    return observed;
  }
  artifactManifest(success: boolean): string {
    const images = inventory(this.config.roots.evidenceRoot, false);
    const path = this.output(success ? "artifact-manifest" : "failure-artifact-manifest", {
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      success,
      files: images,
      selfExcluded: true,
      scope:
        "Actual retained files; only adoption-complete.json records successful canonical transition.",
    });
    return path;
  }
  freshDirectory(name: string): string {
    assert(/^[a-z0-9][a-z0-9-]*$/u.test(name));
    const path = join(this.config.roots.root, name);
    mkdirSync(path, { mode: 0o700 });
    return path;
  }
  selection(path: string) {
    return selected(path);
  }
}
export function errorObservation(value: unknown, depth = 0): Row {
  if (!(value instanceof Error)) {
    return { message: String(value) };
  }
  const result: Row = { name: value.name, message: value.message };
  if (depth < 3 && value.cause !== undefined) {
    result["cause"] = errorObservation(value.cause, depth + 1);
  }
  if (depth < 3 && value instanceof AggregateError) {
    result["errors"] = value.errors
      .slice(0, 8)
      .map((error: unknown) => errorObservation(error, depth + 1));
  }
  return result;
}
export function invoke(module: Row, name: string, args: readonly unknown[]): unknown {
  const operation = module[name];
  assert(typeof operation === "function", "Missing actual owner function: " + name);
  const value: unknown = Reflect.apply(operation, undefined, args);
  return value;
}
export function assertAuthorityResponse(branch: Row, revision: string): void {
  assert.equal(branch["protected"], true);
  assert.equal(row(branch["commit"], "Current protected authority")["sha"], revision);
}
export async function assertCurrentAuthority(
  evidence: AdoptionEvidence,
  label: string,
): Promise<void> {
  assertAuthorityResponse(
    await evidence.github(".github/branches/main", label),
    evidence.config.authorityRevision,
  );
}
export function resultEnvelope(raw: Buffer, command: string, outcome: string): Row {
  const result = row(JSON.parse(raw.toString("utf8")), "Actual public envelope");
  assert.equal(result["schemaVersion"], 1);
  assert.equal(result["command"], command);
  assert.equal(result["outcome"], outcome);
  assert.deepEqual(result["issues"], []);
  return result;
}
