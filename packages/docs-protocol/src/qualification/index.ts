import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, opendir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { planDocumentationDocumentV2 } from "@agent-teams/engineering-foundation/document-authoring";

import { DocsProtocol } from "../application/docs-protocol.js";
import { NodeDocsAdoptionInspector } from "../adapters/node-adoption-inspector.js";
import { NodeCodeAnchorMatcher } from "../adapters/node-code-anchor-matcher.js";
import { NodeFoundationDocsPort } from "../adapters/foundation-docs-port.js";
import { NodeDocsProfileReader } from "../adapters/node-profile-reader.js";
import { normalizeCodeAnchors, normalizeDocumentIds } from "../domain/document-semantics.js";
import type { DocsFindQuery, DocsNewRequest } from "../domain/model.js";

export type { DocsFindQuery, DocsNewRequest } from "../domain/model.js";

export interface DocsProtocolQualificationScenario {
  readonly find: {
    readonly expectedIds: readonly string[];
    readonly query: DocsFindQuery;
  };
  readonly newDocument: Omit<DocsNewRequest, "apply" | "consumerRoot" | "profilePath" | "signal">;
}

export interface DocsProtocolQualificationRequest {
  readonly fixtureRoot: string;
  readonly profilePath?: string;
  readonly scenario: DocsProtocolQualificationScenario;
  readonly signal?: AbortSignal;
}

export interface DocsProtocolQualificationReceipt {
  readonly appliedDocumentPath: string;
  readonly checks: readonly ["info", "find", "preview", "crash", "doctor", "recover", "receipt", "parent", "apply", "index", "check", "source-unchanged"];
  readonly projectId: string;
  readonly schemaVersion: 1;
}

interface TreeEntry {
  readonly kind: "directory" | "file";
  readonly path: string;
}

async function treeEntries(root: string): Promise<readonly TreeEntry[]> {
  const entries: TreeEntry[] = [];
  async function visit(directory: string): Promise<void> {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const absolute = join(directory, entry.name);
      const repositoryPath = relative(root, absolute).split(sep).join("/");
      if (repositoryPath === "node_modules") {continue;}
      if (entry.isSymbolicLink()) {
        throw new Error(`Qualification fixtures cannot contain symlinks: ${repositoryPath}`);
      }
      if (entry.isDirectory()) {
        entries.push({ kind: "directory", path: repositoryPath });
        await visit(absolute);
      } else if (entry.isFile()) {
        entries.push({ kind: "file", path: repositoryPath });
      } else {
        throw new Error(`Qualification fixtures must contain only directories and regular files: ${repositoryPath}`);
      }
    }
  }
  await visit(root);
  return Object.freeze(entries.toSorted((left, right) =>
    Buffer.compare(Buffer.from(`${left.kind}\0${left.path}`), Buffer.from(`${right.kind}\0${right.path}`))));
}

async function bootstrapQualificationInstallation(consumerRoot: string): Promise<void> {
  const docsManifestPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const foundationManifestPath = fileURLToPath(import.meta.resolve("@agent-teams/engineering-foundation/package.json"));
  const [docsManifest, foundationManifest, consumerManifest] = await Promise.all([
    readFile(docsManifestPath, "utf8").then((source) => JSON.parse(source) as { readonly version: string }),
    readFile(foundationManifestPath, "utf8").then((source) => JSON.parse(source) as { readonly version: string }),
    readFile(join(consumerRoot, "package.json"), "utf8").then((source) => JSON.parse(source) as Record<string, unknown>)
  ]);
  await writeFile(join(consumerRoot, "package.json"), `${JSON.stringify({
    ...consumerManifest,
    devDependencies: {
      "@agent-teams/docs-protocol": docsManifest.version,
      "@agent-teams/engineering-foundation": foundationManifest.version
    }
  }, null, 2)}\n`, "utf8");
  const scope = join(consumerRoot, "node_modules", "@agent-teams");
  await mkdir(scope, { recursive: true });
  await Promise.all([
    symlink(dirname(docsManifestPath), join(scope, "docs-protocol"), process.platform === "win32" ? "junction" : "dir"),
    symlink(dirname(foundationManifestPath), join(scope, "engineering-foundation"), process.platform === "win32" ? "junction" : "dir")
  ]);
  await writeFile(join(consumerRoot, ".agent-teams-document-authoring-qualification-fixture.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "agent-teams-document-authoring-qualification-fixture",
    consumerRoot: await realpath(consumerRoot)
  })}\n`, "utf8");
}

async function snapshot(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const entry of await treeEntries(root)) {
    hash.update(entry.kind);
    hash.update("\0");
    hash.update(entry.path);
    hash.update("\0");
    if (entry.kind === "file") {
      hash.update(await readFile(join(root, entry.path)));
      hash.update("\0");
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

async function fileSnapshot(root: string): Promise<ReadonlyMap<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await treeEntries(root)) {
    const key = `${entry.kind}:${entry.path}`;
    result.set(key, entry.kind === "directory"
      ? "directory"
      : `sha256:${createHash("sha256").update(await readFile(join(root, entry.path))).digest("hex")}`);
  }
  return result;
}

async function crashAtDurablePublishing(consumerRoot: string, plan: unknown): Promise<void> {
  const planPath = join(consumerRoot, ".qualification-crash-plan.json");
  const workerPath = join(consumerRoot, ".qualification-crash-worker.mjs");
  await writeFile(planPath, `${JSON.stringify(plan)}\n`, "utf8");
  await writeFile(workerPath, [
    'import { readFile } from "node:fs/promises";',
    'import { runDocumentAuthoringCrashQualification } from "@agent-teams/engineering-foundation/document-authoring/qualification";',
    "const [consumerRoot, planPath] = process.argv.slice(2);",
    'const plan = JSON.parse(await readFile(planPath, "utf8"));',
    'await runDocumentAuthoringCrashQualification({ consumerRoot, plan, crashPoint: "after-publishing-journal-durable" });',
    ""
  ].join("\n"), "utf8");
  const child = spawn(process.execPath, [workerPath, consumerRoot, planPath], {
    cwd: consumerRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => { resolve({ code, signal }); });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => { reject(new Error(`Qualification crash driver did not reach durable PUBLISHING: ${stderr}`)); }, 30_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes('{"schemaVersion":1,"event":"document-authoring-qualification-crash-point","crashPoint":"after-publishing-journal-durable"}\n')) {
          clearTimeout(deadline);
          resolve();
        }
      });
      child.once("error", (error) => { clearTimeout(deadline); reject(error); });
      child.once("exit", (code, signal) => {
        clearTimeout(deadline);
        reject(new Error(`Qualification crash driver exited before checkpoint: ${code}/${signal}: ${stderr}`));
      });
    });
    if (!child.kill("SIGKILL")) {throw new Error("Qualification could not terminate its disposable crash driver.");}
    const termination = await exited;
    if (termination.signal !== "SIGKILL") {
      throw new Error(`Qualification crash driver did not terminate through SIGKILL: ${termination.code}/${termination.signal}.`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {child.kill("SIGKILL");}
    await rm(workerPath, { force: true });
    await rm(planPath, { force: true });
  }
}

function changedPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): readonly string[] {
  return Object.freeze([...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
}

function requireSuccess(label: string, execution: { readonly exitCode: number }): void {
  if (execution.exitCode !== 0) {
    throw new Error(`Docs Protocol qualification ${label} failed with exit code ${execution.exitCode}.`);
  }
}

function documentResult(execution: { readonly envelope: { readonly result: unknown }; readonly exitCode: number }): {
  readonly documentPath: string;
  readonly planDigest: string;
  readonly receiptDigest?: string;
  readonly reachability: unknown;
} {
  requireSuccess("document", execution);
  const result = execution.envelope.result as Record<string, unknown>;
  if (typeof result["documentPath"] !== "string" || typeof result["planDigest"] !== "string" || !("reachability" in result)) {
    throw new Error("Docs Protocol qualification expected a successful document result.");
  }
  return {
    documentPath: result["documentPath"],
    planDigest: result["planDigest"],
    ...(typeof result["receiptDigest"] === "string" ? { receiptDigest: result["receiptDigest"] } : {}),
    reachability: result["reachability"]
  };
}

async function parentState(root: string, documentPath: string): Promise<"directory" | "missing"> {
  const repositoryParent = dirname(documentPath);
  const absolute = resolvePath(root, repositoryParent);
  const relativeParent = relative(resolvePath(root), absolute);
  if (relativeParent === ".." || relativeParent.startsWith(`..${sep}`)) {
    throw new Error("Qualification document parent escapes its owned temporary consumer.");
  }
  try {
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Qualification document parent must be a real directory.");
    }
    return "directory";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {return "missing";}
    throw error;
  }
}

function createProtocol(): DocsProtocol {
  return new DocsProtocol({
    adoption: new NodeDocsAdoptionInspector(),
    anchors: new NodeCodeAnchorMatcher(),
    foundation: new NodeFoundationDocsPort(),
    profiles: new NodeDocsProfileReader()
  });
}

async function applyReachability(root: string, reachability: unknown): Promise<void> {
  const action = reachability as Record<string, unknown>;
  if (action["state"] === "not-required") {
    return;
  }
  if (action["state"] !== "manual-required" || typeof action["indexPath"] !== "string" || typeof action["markdownLink"] !== "string") {
    throw new Error("Qualification apply did not emit one explicit reachability action.");
  }
  const indexPath = resolvePath(root, action["indexPath"]);
  const physicalRoot = await realpath(root);
  const physicalIndex = await realpath(indexPath);
  const pathFromRoot = relative(physicalRoot, physicalIndex);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || !(await lstat(physicalIndex)).isFile()) {
    throw new Error("Qualification reachability index is not a contained regular file.");
  }
  const source = await readFile(physicalIndex, "utf8");
  await writeFile(physicalIndex, `${source.replace(/\n?$/u, "\n")}- ${action["markdownLink"]}\n`);
}

async function interruptAndRecover(input: {
  readonly base: Omit<DocsNewRequest, "apply">;
  readonly consumerRoot: string;
  readonly previewResult: ReturnType<typeof documentResult>;
  readonly profilePath: string;
  readonly protocol: DocsProtocol;
}): Promise<{
  readonly receiptDigest: string;
  readonly receipt: {
    readonly commit: { readonly publication: "published"; readonly state: "committed" };
    readonly directoryMaterialization?: {
      readonly observedCreatedDirectories: readonly string[];
      readonly state: string;
    };
    readonly outcome: "applied";
  };
}> {
  const profile = await new NodeDocsProfileReader().read({
    consumerRoot: input.consumerRoot,
    profilePath: input.profilePath,
    ...(input.base.signal === undefined ? {} : { signal: input.base.signal })
  });
  const blockedBy = normalizeDocumentIds(input.base.blockedBy ?? [], "blocked_by");
  const related = normalizeDocumentIds([...(input.base.related ?? []), ...blockedBy], "related");
  const codeAnchors = normalizeCodeAnchors(input.base.codeAnchors ?? []);
  const crashPlan = await planDocumentationDocumentV2({
    consumerRoot: input.consumerRoot,
    profilePath: profile.foundationProfile.path,
    parentPolicy: "create-missing-real-directories",
    intent: {
      schemaVersion: 1,
      ...input.base.intent,
      ...(related.length === 0 ? {} : { related }),
      additionalMetadata: {
        ...input.base.additionalMetadata,
        blocked_by: blockedBy,
        code_anchors: codeAnchors.map(({ enforcement, pattern }) => ({ enforcement, pattern }))
      }
    },
    ...(input.base.signal === undefined ? {} : { signal: input.base.signal })
  });
  if (crashPlan.destination !== input.previewResult.documentPath || crashPlan.planDigest !== input.previewResult.planDigest) {
    throw new Error("Qualification crash Plan differs from the unified Docs Protocol preview.");
  }
  await crashAtDurablePublishing(input.consumerRoot, crashPlan);
  const interruptedDoctor = await input.protocol.doctor({ consumerRoot: input.consumerRoot, profilePath: input.profilePath });
  if (interruptedDoctor.exitCode !== 1 || interruptedDoctor.envelope.outcome !== "recovery-required" ||
    interruptedDoctor.envelope.result.transaction.state !== "recoverable") {
    throw new Error("Qualification doctor did not observe its genuine interrupted transaction.");
  }
  const recovered = await input.protocol.recover({
    consumerRoot: input.consumerRoot,
    profilePath: input.profilePath,
    ...(input.base.signal === undefined ? {} : { signal: input.base.signal })
  });
  requireSuccess("recover", recovered);
  if (recovered.envelope.result.transactionState !== "recovered" || recovered.envelope.result.writeState !== "committed" ||
    typeof recovered.envelope.result.receiptDigest !== "string" || recovered.envelope.result.receipt.outcome !== "applied" ||
    recovered.envelope.result.receipt.commit.state !== "committed" || recovered.envelope.result.receipt.commit.publication !== "published") {
    throw new Error("Qualification recovery did not return truthful committed Receipt evidence.");
  }
  return recovered.envelope.result as {
    readonly receiptDigest: string;
    readonly receipt: {
      readonly commit: { readonly publication: "published"; readonly state: "committed" };
      readonly directoryMaterialization?: { readonly observedCreatedDirectories: readonly string[]; readonly state: string };
      readonly outcome: "applied";
    };
  };
}

export async function runDocsProtocolQualification(request: DocsProtocolQualificationRequest): Promise<DocsProtocolQualificationReceipt> {
  const sourceRoot = await realpath(resolvePath(request.fixtureRoot));
  const before = await snapshot(sourceRoot);
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "agent-teams-docs-qualification-")));
  const consumerRoot = join(temporary, "consumer");
  const profilePath = request.profilePath ?? "architecture/foundation/docs-protocol.yaml";
  try {
    request.signal?.throwIfAborted();
    await cp(sourceRoot, consumerRoot, { recursive: true, errorOnExist: true, force: false, dereference: false });
    await bootstrapQualificationInstallation(consumerRoot);
    const protocol = createProtocol();
    const info = await protocol.info({ consumerRoot, profilePath });
    requireSuccess("info", info);
    const find = await protocol.find({ consumerRoot, profilePath, query: request.scenario.find.query, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    requireSuccess("find", find);
    const ids = find.envelope.result.documents.map(({ id }) => id);
    if (JSON.stringify(ids) !== JSON.stringify(request.scenario.find.expectedIds)) {
      throw new Error(`Docs Protocol qualification find mismatch: ${JSON.stringify(ids)}.`);
    }
    const base = { ...request.scenario.newDocument, consumerRoot, profilePath, ...(request.signal === undefined ? {} : { signal: request.signal }) };
    const beforePreview = await fileSnapshot(consumerRoot);
    const preview = await protocol.newDocument({ ...base, apply: false });
    requireSuccess("preview", preview);
    if (changedPaths(beforePreview, await fileSnapshot(consumerRoot)).length !== 0) {
      throw new Error("Preview mutated its owned disposable consumer.");
    }
    const previewResult = documentResult(preview);
    const parentBeforeApply = await parentState(consumerRoot, previewResult.documentPath);
    const recovered = await interruptAndRecover({ base, consumerRoot, previewResult, profilePath, protocol });
    const appliedResult = {
      ...previewResult,
      receiptDigest: recovered.receiptDigest
    };
    const applyChanges = changedPaths(beforePreview, await fileSnapshot(consumerRoot));
    const expectedDirectories = new Set<string>(
      recovered.receipt.directoryMaterialization?.observedCreatedDirectories ?? []
    );
    const unexpectedApplyChanges = applyChanges.filter((entry) => {
      const path = entry.slice(entry.indexOf(":") + 1);
      return path !== appliedResult.documentPath &&
        path !== ".agent-teams-local" &&
        !expectedDirectories.has(path) &&
        !path.startsWith(".agent-teams-local/") &&
        !path.endsWith("/.foundation-retired-evidence-") &&
        !path.includes("/.foundation-retired-evidence-/");
    });
    if (unexpectedApplyChanges.length > 0) {
      throw new Error(`Apply changed paths outside its exact document and Foundation transaction lifecycle: ${JSON.stringify(unexpectedApplyChanges)}.`);
    }
    if (await parentState(consumerRoot, appliedResult.documentPath) !== "directory") {
      throw new Error("Apply did not leave a real document parent directory.");
    }
    if (parentBeforeApply === "missing" && recovered.receipt.directoryMaterialization?.state !== "created-and-retained") {
      throw new Error("Missing-parent qualification recovery did not truthfully report retained Plan v2 materialization.");
    }
    await applyReachability(consumerRoot, appliedResult.reachability);
    const check = await protocol.check({ consumerRoot, profilePath });
    if (check.exitCode !== 0) {throw new Error(`Docs Protocol qualification check failed: ${JSON.stringify(check.envelope)}.`);}
    const doctor = await protocol.doctor({ consumerRoot, profilePath });
    requireSuccess("doctor", doctor);
    if (await snapshot(sourceRoot) !== before) {
      throw new Error("Qualification modified its source fixture.");
    }
    return Object.freeze({
      appliedDocumentPath: appliedResult.documentPath,
      checks: Object.freeze(["info", "find", "preview", "crash", "doctor", "recover", "receipt", "parent", "apply", "index", "check", "source-unchanged"] as const),
      projectId: info.envelope.result.projectId,
      schemaVersion: 1
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
