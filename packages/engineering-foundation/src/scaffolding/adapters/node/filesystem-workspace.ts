import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  MaterializeFileOperationV1,
  ScaffoldDiagnosticV1,
  ScaffoldOperationReceiptV1,
  ScaffoldPlanV1,
  ScaffoldReceiptV1
} from "../../contract/types.js";
import { sha256Bytes, sha256Text } from "../../kernel/canonical-json.js";
import { assertScaffoldPlanDigest } from "../../kernel/compiler.js";
import { createScaffoldReceipt } from "../../kernel/receipt.js";
import { ScaffoldError } from "../../scaffold-error.js";
import { assertSchema } from "../../../schema-catalog.js";
import { parseStrictYamlSource } from "../../../strict-yaml.js";
import {
  acquireFoundationOperationLock
} from "../../../local-mode/service.js";
import { LOCAL_STATE_DIRECTORY } from "../../../local-mode/types.js";
import {
  inspectAuthorityReadSet,
  MAX_SCAFFOLD_PLAN_BYTES
} from "./node-input-loader.js";
import { assertPlanMatchesConsumerAuthority } from "./node-plan-authority.js";

const JOURNAL_FILE = "scaffolding-transaction.json";
const PROTECTED_ROOTS = new Set([
  ".agent-teams-local",
  ".git",
  "node_modules"
]);
const WINDOWS_RESERVED_NAMES = new Set([
  "AUX",
  "CON",
  "NUL",
  "PRN",
  ...Array.from({ length: 9 }, (_unused, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `LPT${index + 1}`)
]);

type FileState = "absent" | "after" | "conflict";

interface TransactionJournalV1 {
  readonly schemaVersion: 1;
  readonly state: "PREPARED";
  readonly plan: ScaffoldPlanV1;
}

function diagnostic(
  ruleId: string,
  phase: ScaffoldDiagnosticV1["phase"],
  subject: string,
  message: string,
  remediation: string
): ScaffoldDiagnosticV1 {
  return Object.freeze({
    ruleId,
    severity: "error" as const,
    phase,
    subject,
    message,
    remediation
  });
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  );
}

function assertSafeOperationPaths(plan: ScaffoldPlanV1): void {
  const folded = new Map<string, string>();
  const operationIds = new Set<string>();
  const targetPrefix = `${plan.target.path}/`;
  for (const operation of plan.operations) {
    const segments = operation.path.split("/");
    if (
      !operation.path.startsWith(targetPrefix) ||
      operation.path.length === 0 ||
      operation.path.length > 512 ||
      operation.path.includes("\\") ||
      isAbsolute(operation.path) ||
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment.length > 255 ||
          segment.endsWith(".") ||
          Array.from(segment).some(
            (character) => (character.codePointAt(0) ?? 0) < 32
          ) ||
          WINDOWS_RESERVED_NAMES.has((segment.split(".")[0] ?? "").toUpperCase())
      ) ||
      segments.some((segment) => PROTECTED_ROOTS.has(segment.toLowerCase()))
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_PLAN_INVALID",
        `Scaffolding operation path is unsafe: ${operation.path}.`
      );
    }
    const key = operation.path.toLowerCase();
    const existing = folded.get(key);
    if (existing !== undefined) {
      throw new ScaffoldError(
        "SCAFFOLD_PLAN_INVALID",
        existing === operation.path
          ? `Duplicate scaffolding operation path: ${operation.path}.`
          : `Scaffolding operation paths collide under case folding: ${existing}, ${operation.path}.`
      );
    }
    if (operationIds.has(operation.id)) {
      throw new ScaffoldError(
        "SCAFFOLD_PLAN_INVALID",
        `Duplicate scaffolding operation ID: ${operation.id}.`
      );
    }
    folded.set(key, operation.path);
    operationIds.add(operation.id);
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      ["EACCES", "EINVAL", "EISDIR", "EPERM"].includes(
        (error as NodeJS.ErrnoException).code ?? ""
      )
    ) {
      return;
    }
    throw error;
  }
}

async function writeDurableJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporary = `${path}.tmp`;
  await rm(temporary, { force: true });
  let renamed = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    renamed = true;
    await syncDirectory(parent);
  } finally {
    if (!renamed) {
      await rm(temporary, { force: true });
    }
  }
}

async function readJournal(path: string): Promise<TransactionJournalV1 | undefined> {
  let source: string;
  try {
    const metadata = await lstat(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > MAX_SCAFFOLD_PLAN_BYTES
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        "Scaffolding recovery journal is not a bounded regular file."
      );
    }
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
  const value = parseStrictYamlSource(source, "scaffold-recovery-journal");
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("state" in value) ||
    value.state !== "PREPARED" ||
    !("plan" in value)
  ) {
    throw new ScaffoldError(
      "SCAFFOLD_RECOVERY_REQUIRED",
      "Scaffolding recovery journal is invalid."
    );
  }
  await assertSchema("scaffold-plan/v1", value.plan, "scaffold-recovery-journal");
  const plan = value.plan as ScaffoldPlanV1;
  assertScaffoldPlanDigest(plan);
  return Object.freeze({ schemaVersion: 1, state: "PREPARED", plan });
}

async function classifyFile(
  root: string,
  operation: MaterializeFileOperationV1
): Promise<FileState> {
  const destination = resolve(root, operation.path);
  if (!isContained(root, destination)) {
    return "conflict";
  }
  try {
    const metadata = await lstat(destination);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return "conflict";
    }
    const bytes = await readFile(destination);
    const modeMatches =
      process.platform === "win32" || (metadata.mode & 0o777) === 0o644;
    return sha256Bytes(bytes) === operation.after.digest && modeMatches
      ? "after"
      : "conflict";
  } catch (error) {
    if (isMissing(error)) {
      return "absent";
    }
    throw error;
  }
}

async function assertNoCaseCollision(
  parent: string,
  requestedName: string
): Promise<void> {
  const entries = await readdir(parent).catch((error: unknown) => {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  });
  const collision = entries.find(
    (entry) =>
      entry !== requestedName && entry.toLowerCase() === requestedName.toLowerCase()
  );
  if (collision !== undefined) {
    throw new ScaffoldError(
      "SCAFFOLD_APPLY_CONFLICT",
      `Path collides under case folding: ${collision}, ${requestedName}.`
    );
  }
}

async function ensureSafeParent(root: string, repositoryPath: string): Promise<string> {
  const segments = repositoryPath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    await assertNoCaseCollision(current, segment);
    const next = join(current, segment);
    try {
      const metadata = await lstat(next);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new ScaffoldError(
          "SCAFFOLD_APPLY_CONFLICT",
          `Scaffolding parent is not a real directory: ${repositoryPath}.`
        );
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      await mkdir(next);
      await syncDirectory(current);
    }
    const canonical = await realpath(next);
    if (!isContained(root, canonical)) {
      throw new ScaffoldError(
        "SCAFFOLD_APPLY_CONFLICT",
        `Scaffolding parent escapes the repository: ${repositoryPath}.`
      );
    }
    current = canonical;
  }
  await assertNoCaseCollision(current, segments.at(-1) ?? "");
  return current;
}

async function assertSafeExistingAncestors(
  root: string,
  repositoryPath: string
): Promise<void> {
  const segments = repositoryPath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    await assertNoCaseCollision(current, segment);
    const next = join(current, segment);
    const metadata = await lstat(next).catch((error: unknown) => {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    });
    if (metadata === null) {
      return;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ScaffoldError(
        "SCAFFOLD_APPLY_CONFLICT",
        `Scaffolding parent is not a real directory: ${repositoryPath}.`
      );
    }
    const canonical = await realpath(next);
    if (!isContained(root, canonical)) {
      throw new ScaffoldError(
        "SCAFFOLD_APPLY_CONFLICT",
        `Scaffolding parent escapes the repository: ${repositoryPath}.`
      );
    }
    current = canonical;
  }
  await assertNoCaseCollision(current, segments.at(-1) ?? "");
}

function transactionTemporaryName(
  planDigest: string,
  operation: MaterializeFileOperationV1
): string {
  const identity = sha256Text(`${planDigest}:${operation.id}`).slice(
    "sha256:".length
  );
  return `.foundation-${identity}.tmp`;
}

async function removeTransactionTemporary(
  root: string,
  planDigest: string,
  operation: MaterializeFileOperationV1
): Promise<void> {
  const parent = dirname(resolve(root, operation.path));
  const temporary = join(parent, transactionTemporaryName(planDigest, operation));
  try {
    const metadata = await lstat(temporary);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        `Scaffolding temporary path is not a file: ${operation.path}.`
      );
    }
    await rm(temporary, { force: true });
    await syncDirectory(parent);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

async function assertTransactionTemporariesAbsent(
  root: string,
  plan: ScaffoldPlanV1
): Promise<void> {
  for (const operation of plan.operations) {
    const parent = dirname(resolve(root, operation.path));
    const temporary = join(
      parent,
      transactionTemporaryName(plan.planDigest, operation)
    );
    const metadata = await lstat(temporary).catch((error: unknown) => {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    });
    if (metadata !== null) {
      throw new ScaffoldError(
        "SCAFFOLD_APPLY_CONFLICT",
        `Scaffolding transaction temporary path already exists: ${operation.path}.`
      );
    }
  }
}

async function publishOperation(
  root: string,
  operation: MaterializeFileOperationV1,
  planDigest: string,
  operationIndex: number,
  faultInjector?: ScaffoldFilesystemFaultInjector
): Promise<"already-satisfied" | "applied"> {
  const state = await classifyFile(root, operation);
  if (state === "after") {
    return "already-satisfied";
  }
  if (state === "conflict") {
    throw new ScaffoldError(
      "SCAFFOLD_APPLY_CONFLICT",
      `Scaffolding output changed concurrently: ${operation.path}.`
    );
  }
  const parent = await ensureSafeParent(root, operation.path);
  const destination = join(parent, basename(operation.path));
  const temporary = join(parent, transactionTemporaryName(planDigest, operation));
  const bytes = Buffer.from(operation.after.contentBase64, "base64");
  await rm(temporary, { force: true });
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await faultInjector?.({
        phase: "after-temporary-written",
        operationIndex,
        operationPath: operation.path
      });
      await handle.chmod(0o644);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await faultInjector?.({
      phase: "after-temporary-synced",
      operationIndex,
      operationPath: operation.path
    });
    try {
      await link(temporary, destination);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        const concurrentState = await classifyFile(root, operation);
        if (concurrentState === "after") {
          return "already-satisfied";
        }
        throw new ScaffoldError(
          "SCAFFOLD_APPLY_CONFLICT",
          `Scaffolding output changed concurrently: ${operation.path}.`,
          [],
          { cause: error }
        );
      }
      throw error;
    }
    await faultInjector?.({
      phase: "after-hard-link",
      operationIndex,
      operationPath: operation.path
    });
    await syncDirectory(parent);
  } finally {
    await rm(temporary, { force: true });
  }
  if ((await classifyFile(root, operation)) !== "after") {
    throw new ScaffoldError(
      "SCAFFOLD_RECOVERY_REQUIRED",
      `Published scaffolding output failed digest verification: ${operation.path}.`
    );
  }
  return "applied";
}

async function classifyPlan(
  root: string,
  plan: ScaffoldPlanV1
): Promise<readonly {
  readonly operation: MaterializeFileOperationV1;
  readonly state: FileState;
}[]> {
  return Promise.all(
    plan.operations.map(async (operation) => ({
      operation,
      state: await classifyFile(root, operation)
    }))
  );
}

function conflictReceipt(
  plan: ScaffoldPlanV1,
  classifications: readonly {
    readonly operation: MaterializeFileOperationV1;
    readonly state: FileState;
  }[],
  phase: "apply" | "recovery"
): ScaffoldReceiptV1 {
  const conflicting = classifications.filter(({ state }) => state === "conflict");
  return createScaffoldReceipt({
    plan,
    adapterId: "foundation.filesystem/v1",
    outcome: phase === "recovery" ? "recovery-required" : "rejected",
    commitState: phase === "recovery" ? "recovery-required" : "rejected",
    atomicity: "journaled-recoverable",
    operations: classifications.map(({ operation, state }) => ({
      operationId: operation.id,
      path: operation.path,
      outcome:
        state === "conflict"
          ? "conflict"
          : state === "after"
            ? "already-satisfied"
            : "not-applied",
      ...(state === "after" ? { resultDigest: operation.after.digest } : {})
    })),
    diagnostics: conflicting.map(({ operation }) =>
      diagnostic(
        phase === "recovery"
          ? "scaffolding.recovery.third-state"
          : "scaffolding.apply.precondition-conflict",
        phase,
        operation.path,
        "File matches neither the Plan precondition nor its desired result.",
        phase === "recovery"
          ? "Resolve the file manually, then retry recovery."
          : "Create a new Intent and Plan from the current workspace state."
      )
    )
  });
}

async function finishPlan(
  root: string,
  plan: ScaffoldPlanV1,
  recovered: boolean,
  faultInjector?: ScaffoldFilesystemFaultInjector
): Promise<ScaffoldReceiptV1> {
  for (const operation of plan.operations) {
    await removeTransactionTemporary(root, plan.planDigest, operation);
  }
  const initial = await classifyPlan(root, plan);
  if (initial.some(({ state }) => state === "conflict")) {
    return conflictReceipt(plan, initial, recovered ? "recovery" : "apply");
  }
  const operationReceipts: ScaffoldOperationReceiptV1[] = [];
  for (const [operationIndex, { operation, state }] of initial.entries()) {
    if (recovered && state === "after") {
      await syncDirectory(dirname(resolve(root, operation.path)));
    }
    const outcome =
      state === "after"
        ? "already-satisfied"
        : await publishOperation(
            root,
            operation,
            plan.planDigest,
            operationIndex,
            faultInjector
          );
    operationReceipts.push({
      operationId: operation.id,
      path: operation.path,
      outcome: recovered && outcome === "applied" ? "recovered" : outcome,
      resultDigest: operation.after.digest
    });
    await faultInjector?.({
      phase: "after-operation-published",
      operationIndex,
      operationPath: operation.path
    });
  }
  const finalState = await classifyPlan(root, plan);
  if (finalState.some(({ state }) => state !== "after")) {
    return conflictReceipt(plan, finalState, "recovery");
  }
  return createScaffoldReceipt({
    plan,
    adapterId: "foundation.filesystem/v1",
    outcome: recovered ? "failed-recovered" : "applied",
    commitState: recovered ? "recovered" : "committed",
    atomicity: "journaled-recoverable",
    operations: operationReceipts
  });
}

async function removeJournal(path: string): Promise<void> {
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
}

export async function recoverFilesystemScaffold(
  consumerRoot: string
): Promise<ScaffoldReceiptV1 | undefined> {
  const canonicalRoot = await realpath(resolve(consumerRoot));
  const release = await acquireFoundationOperationLock(canonicalRoot);
  try {
    const journalPath = join(canonicalRoot, LOCAL_STATE_DIRECTORY, JOURNAL_FILE);
    const journal = await readJournal(journalPath);
    if (journal === undefined) {
      return undefined;
    }
    assertSafeOperationPaths(journal.plan);
    for (const operation of journal.plan.operations) {
      await assertSafeExistingAncestors(canonicalRoot, operation.path);
    }
    const receipt = await finishPlan(canonicalRoot, journal.plan, true);
    if (receipt.outcome !== "recovery-required") {
      await removeJournal(journalPath);
    }
    return receipt;
  } finally {
    await release();
  }
}

export async function applyFilesystemScaffold(
  consumerRoot: string,
  plan: ScaffoldPlanV1
): Promise<ScaffoldReceiptV1> {
  return applyFilesystemScaffoldWithFaultInjection(consumerRoot, plan);
}

interface ScaffoldFilesystemFaultPoint {
  readonly phase:
    | "after-journal-prepared"
    | "after-hard-link"
    | "after-operation-published"
    | "after-temporary-synced"
    | "after-temporary-written"
    | "before-journal-removed";
  readonly operationIndex?: number;
  readonly operationPath?: string;
}

type ScaffoldFilesystemFaultInjector = (
  point: ScaffoldFilesystemFaultPoint
) => Promise<void> | void;

/** Internal conformance seam. It is intentionally absent from package exports. */
export async function applyFilesystemScaffoldWithFaultInjection(
  consumerRoot: string,
  plan: ScaffoldPlanV1,
  faultInjector?: ScaffoldFilesystemFaultInjector
): Promise<ScaffoldReceiptV1> {
  await assertSchema("scaffold-plan/v1", plan, "scaffold-apply-plan");
  assertScaffoldPlanDigest(plan);
  assertSafeOperationPaths(plan);
  const canonicalRoot = await realpath(resolve(consumerRoot));
  const release = await acquireFoundationOperationLock(canonicalRoot);
  try {
    const journalPath = join(canonicalRoot, LOCAL_STATE_DIRECTORY, JOURNAL_FILE);
    const existingJournal = await readJournal(journalPath);
    if (
      existingJournal !== undefined &&
      existingJournal.plan.planDigest !== plan.planDigest
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_RECOVERY_REQUIRED",
        "A different scaffolding Plan requires recovery before this Plan can apply."
      );
    }
    if (existingJournal !== undefined) {
      for (const operation of existingJournal.plan.operations) {
        await assertSafeExistingAncestors(canonicalRoot, operation.path);
      }
      const recovered = await finishPlan(canonicalRoot, existingJournal.plan, true);
      if (recovered.outcome !== "recovery-required") {
        await removeJournal(journalPath);
      }
      return recovered;
    }

    if (!(await inspectAuthorityReadSet(canonicalRoot, plan.readSet))) {
      return createScaffoldReceipt({
        plan,
        adapterId: "foundation.filesystem/v1",
        outcome: "rejected",
        commitState: "rejected",
        atomicity: "journaled-recoverable",
        operations: [],
        diagnostics: [
          diagnostic(
            "scaffolding.apply.stale-authority-snapshot",
            "apply",
            plan.projectId,
            "Consumer configuration or target authority changed after planning.",
            "Compile a new Plan from the current consumer state."
          )
        ]
      });
    }
    await assertPlanMatchesConsumerAuthority(canonicalRoot, plan);
    const classifications = await classifyPlan(canonicalRoot, plan);
    if (classifications.some(({ state }) => state === "conflict")) {
      return conflictReceipt(plan, classifications, "apply");
    }
    if (classifications.every(({ state }) => state === "after")) {
      return createScaffoldReceipt({
        plan,
        adapterId: "foundation.filesystem/v1",
        outcome: "already-applied",
        commitState: "committed",
        atomicity: "journaled-recoverable",
        operations: classifications.map(({ operation }) => ({
          operationId: operation.id,
          path: operation.path,
          outcome: "already-satisfied",
          resultDigest: operation.after.digest
        }))
      });
    }

    for (const operation of plan.operations) {
      await assertSafeExistingAncestors(canonicalRoot, operation.path);
    }
    await assertTransactionTemporariesAbsent(canonicalRoot, plan);

    await writeDurableJson(journalPath, {
      schemaVersion: 1,
      state: "PREPARED",
      plan
    } satisfies TransactionJournalV1);
    await faultInjector?.({ phase: "after-journal-prepared" });
    try {
      const receipt = await finishPlan(canonicalRoot, plan, false, faultInjector);
      if (receipt.outcome !== "recovery-required") {
        await faultInjector?.({ phase: "before-journal-removed" });
        await removeJournal(journalPath);
      }
      return receipt;
    } catch {
      const recovered = await finishPlan(canonicalRoot, plan, true);
      if (recovered.outcome !== "recovery-required") {
        await removeJournal(journalPath);
      }
      return recovered;
    }
  } finally {
    await release();
  }
}
