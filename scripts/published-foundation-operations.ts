import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import { inspectPublishedFoundationImports, withPublishedCompilerFloor, type PublishedFoundationVersion } from "./published-foundation-imports.ts";

type Operation = "plan" | "apply" | "recover" | "attach" | "detach" | "status";
export interface PublishedFoundationOperationRequest {
  readonly packageRoot: string;
  readonly version: PublishedFoundationVersion;
  readonly consumerRoot: string;
  readonly operation: Operation;
  readonly inputPath?: string;
  readonly targetRoot?: string;
}

interface ObservationIdentity {
  readonly boundary: "published-operation";
  readonly version: PublishedFoundationVersion;
  readonly operation: Operation;
  readonly importClosureDigest: string;
}
export type PublishedFoundationOperationObservation = ObservationIdentity & (
  { readonly outcome: "returned"; readonly value: unknown } |
  { readonly outcome: "threw"; readonly error: { readonly name: string; readonly code: string | null; readonly message: string } }
);

function fail(message: string): never { throw new Error(`Published Foundation operation selection failed: ${message}.`); }

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) { fail("expected an operation object"); }
  return value as Record<string, unknown>;
}

function select(request: PublishedFoundationOperationRequest): void {
  const allowed: Readonly<Record<PublishedFoundationVersion, readonly Operation[]>> = {
    "0.11.0": ["recover", "attach", "detach"], "0.12.0": ["plan", "apply"], "0.14.0": ["status", "recover", "attach", "detach"],
  };
  if (!Object.hasOwn(allowed, request.version) || !allowed[request.version].includes(request.operation)) { fail("unsupported historical version/operation pair"); }
  if (!isAbsolute(request.packageRoot) || !isAbsolute(request.consumerRoot)) { fail("package and consumer roots must be absolute"); }
  const pathOperation = request.operation === "plan" || request.operation === "apply";
  if (pathOperation && (typeof request.inputPath !== "string" || isAbsolute(request.inputPath) ||
    request.inputPath.split(/[\\/]/u).some(segment => segment === "" || segment === "." || segment === ".."))) { fail("Plan/Intent path must be repository relative"); }
  if (request.operation === "attach" && (typeof request.targetRoot !== "string" || !isAbsolute(request.targetRoot))) { fail("attach requires an absolute unreachable target"); }
  if ((!pathOperation && request.inputPath !== undefined) || (request.operation !== "attach" && request.targetRoot !== undefined)) { fail("operation has unrelated path arguments"); }
}

function sameBarrierFile(before: BigIntStats, after: BigIntStats): boolean {
  return after.isFile() && !after.isSymbolicLink() &&
    (["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs", "nlink"] as const).every(key => before[key] === after[key]);
}

async function readHistoricalBarrier(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const metadata = await file.stat({ bigint: true });
    if (!metadata.isFile() || metadata.size > 16n * 1024n * 1024n ||
      !sameBarrierFile(metadata, await lstat(path, { bigint: true }))) { fail("historical barrier evidence must be a bounded regular file"); }
    const bytes = Buffer.alloc(Number(metadata.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) { break; }
      offset += bytesRead;
    }
    if (BigInt(offset) !== metadata.size || !sameBarrierFile(metadata, await file.stat({ bigint: true })) ||
      !sameBarrierFile(metadata, await lstat(path, { bigint: true }))) { fail("historical barrier evidence changed during its bounded read"); }
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}

async function assertHistoricalScenario(request: PublishedFoundationOperationRequest): Promise<void> {
  if (request.version === "0.12.0") { return; }
  const relative = request.version === "0.11.0" ? "foundation-operation.lock" : "scaffolding-transaction.json";
  const path = join(request.consumerRoot, ".agent-teams-local", relative);
  const evidence = object(JSON.parse((await readHistoricalBarrier(path)).toString("utf8")) as unknown);
  if (request.version === "0.11.0" ? evidence["schemaVersion"] !== 1 || evidence["kind"] !== "transaction-barrier" : evidence["schemaVersion"] !== 3) {
    fail("operation is outside the named historical barrier scenario");
  }
  if (request.operation === "attach") {
    try { await lstat(request.targetRoot!); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") { return; }
      throw error;
    }
    fail("historical attach target must remain unreachable");
  }
}

function invoke(module: Record<string, unknown>, name: string, args: readonly unknown[]): unknown {
  const callable = module[name];
  if (typeof callable !== "function") { fail(`original public operation ${name} is unavailable`); }
  return Reflect.apply(callable, module, args) as unknown;
}

function construct(module: Record<string, unknown>, name: string, args: readonly unknown[]): Record<string, unknown> {
  const constructor = module[name];
  if (typeof constructor !== "function") { fail(`original public constructor ${name} is unavailable`); }
  return object(Reflect.construct(constructor, args) as unknown);
}

async function execute(request: PublishedFoundationOperationRequest, entry: string): Promise<unknown> {
  const module = object(await import(pathToFileURL(entry).href) as unknown);
  switch (request.operation) {
    case "plan": return invoke(module, "planScaffoldFromFile", [{ consumerRoot: request.consumerRoot, intentPath: request.inputPath }]);
    case "apply": {
      const plan = await invoke(module, "readScaffoldPlanFile", [request.consumerRoot, request.inputPath]);
      return invoke(module, "applyFilesystemScaffold", [request.consumerRoot, plan]);
    }
    case "recover": return invoke(module, "recoverFilesystemScaffold", [request.consumerRoot]);
    default: {
      const runner = construct(module, "NodeProcessRunner", []);
      const service = construct(module, "FoundationLocalModeService", [{ runner, now: () => new Date() }]);
      return invoke(service, request.operation, request.operation === "attach" ? [request.consumerRoot, request.targetRoot] : [request.consumerRoot]);
    }
  }
}

export async function executePublishedFoundationOperation(request: PublishedFoundationOperationRequest): Promise<PublishedFoundationOperationObservation> {
  select(request);
  await assertHistoricalScenario(request);
  const subpath = ["plan", "apply", "recover"].includes(request.operation) ? "scaffolding" : "local-mode";
  const closure = inspectPublishedFoundationImports(request.packageRoot, request.version, subpath);
  const identity: ObservationIdentity = { boundary: "published-operation", version: request.version,
    operation: request.operation, importClosureDigest: closure.digest };
  return withPublishedCompilerFloor(async () => {
    try { return { ...identity, outcome: "returned", value: await execute(request, closure.entry) }; }
    catch (error) {
      if (!(error instanceof Error)) { throw error; }
      const code = "code" in error && typeof error.code === "string" ? error.code : null;
      return { ...identity, outcome: "threw", error: { name: error.name, code, message: error.message } };
    }
  });
}
