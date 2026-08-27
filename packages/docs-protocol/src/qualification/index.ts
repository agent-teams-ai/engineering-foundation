import { cp, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";

import type { DocsFindQuery, DocsNewRequest } from "../domain/model.js";
import { applyReachability, changedPaths, fileSnapshot, snapshot } from "./filesystem-evidence.js";
import {
  bootstrapQualificationInstallation,
  createProtocol,
  documentResult,
  interruptAndRecover,
  requireSuccess
} from "./qualification-runtime.js";

export type { DocumentJsonValue } from "@agent-teams/engineering-foundation/document-authoring";
export type { DocsFindQuery, DocsNewRequest } from "../domain/model.js";
export { runDocsProtocolQualificationV2 } from "./qualification-v2-runner.js";
export type {
  DocsProtocolQualificationContractV2,
  DocsProtocolQualificationReceiptV2,
  DocsProtocolQualificationScenarioV2,
  DocsProtocolQualificationV2Request
} from "./v2-contract.js";

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

export async function runDocsProtocolQualification(request: DocsProtocolQualificationRequest): Promise<DocsProtocolQualificationReceipt> {
  const sourceRoot = await realpath(resolvePath(request.fixtureRoot));
  const before = await snapshot(sourceRoot);
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "atd-q-")));
  const consumerRoot = join(temporary, "consumer");
  const profilePath = request.profilePath ?? "architecture/foundation/docs-protocol.yaml";
  try {
    request.signal?.throwIfAborted();
    await cp(sourceRoot, consumerRoot, { recursive: true, errorOnExist: true, force: false, dereference: false });
    await bootstrapQualificationInstallation(consumerRoot, true);
    const protocol = createProtocol();
    const info = await protocol.infoV2({ consumerRoot, profilePath, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    requireSuccess("info", info);
    const find = await protocol.findV2({ consumerRoot, profilePath, query: request.scenario.find.query, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    requireSuccess("find", find);
    const ids = find.envelope.result.documents.map(({ id }) => id);
    if (JSON.stringify(ids) !== JSON.stringify(request.scenario.find.expectedIds)) {
      throw new Error(`Docs Protocol qualification find mismatch: ${JSON.stringify(ids)}.`);
    }
    const base = { ...request.scenario.newDocument, consumerRoot, profilePath, ...(request.signal === undefined ? {} : { signal: request.signal }) };
    const beforePreview = await fileSnapshot(consumerRoot);
    const preview = await protocol.newDocumentV2({ ...base, apply: false });
    requireSuccess("preview", preview);
    if (changedPaths(beforePreview, await fileSnapshot(consumerRoot)).length !== 0) {
      throw new Error("Preview mutated its owned disposable consumer.");
    }
    const previewResult = documentResult(preview);
    const parentBeforeApply = await parentState(consumerRoot, previewResult.documentPath);
    const recovered = await interruptAndRecover({ base, consumerRoot, previewResult, profilePath, protocol });
    const appliedResult = { ...previewResult, receiptDigest: recovered.receiptDigest };
    const applyChanges = changedPaths(beforePreview, await fileSnapshot(consumerRoot));
    const expectedDirectories = new Set<string>(recovered.receipt.directoryMaterialization?.observedCreatedDirectories ?? []);
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
    const check = await protocol.checkV2({ consumerRoot, profilePath, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (check.exitCode !== 0) {throw new Error(`Docs Protocol qualification check failed: ${JSON.stringify(check.envelope)}.`);}
    const doctor = await protocol.doctorV2({ consumerRoot, profilePath, ...(request.signal === undefined ? {} : { signal: request.signal }) });
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
