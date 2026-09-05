import { changedPaths } from "./evidence-policy.js";
import { documentResult, requireSuccess, type PortableQualificationProtocol } from "./runtime.js";
import type { DocsProtocolQualificationRequest, DocsProtocolQualificationReceipt } from "./model.js";
import type { createInterruptAndRecover } from "./recovery.js";
import type { QualificationWorkspace } from "./workspace.js";

export function createQualificationRunner(dependencies: {
  readonly workspace: QualificationWorkspace;
  readonly createProtocol: () => PortableQualificationProtocol;
  readonly interruptAndRecover: ReturnType<typeof createInterruptAndRecover>;
}) {
  const { workspace } = dependencies;
  return async function runDocsProtocolQualification(request: DocsProtocolQualificationRequest): Promise<DocsProtocolQualificationReceipt> {
    const sourceRoot = await workspace.resolveRoot(request.fixtureRoot);
    const before = await workspace.snapshot(sourceRoot);
    const disposable = await workspace.createDisposable();
    const { consumerRoot } = disposable;
    const profilePath = request.profilePath ?? "docs.config.yaml";
    try {
      request.signal?.throwIfAborted();
      await disposable.copyFrom(sourceRoot);
      await workspace.bootstrapInstallation(consumerRoot, true);
      const protocol = dependencies.createProtocol();
      const info = await protocol.infoV2({ consumerRoot, profilePath, ...(request.signal === undefined ? {} : { signal: request.signal }) });
      requireSuccess("info", info);
      const find = await protocol.findV2({ consumerRoot, profilePath, query: request.scenario.find.query, ...(request.signal === undefined ? {} : { signal: request.signal }) });
      requireSuccess("find", find);
      const ids = find.envelope.result.documents.map(({ id }) => id);
      if (JSON.stringify(ids) !== JSON.stringify(request.scenario.find.expectedIds)) {
        throw new Error(`Docs Protocol qualification find mismatch: ${JSON.stringify(ids)}.`);
      }
      const base = { ...request.scenario.newDocument, consumerRoot, profilePath, ...(request.signal === undefined ? {} : { signal: request.signal }) };
      const beforePreview = await workspace.fileSnapshot(consumerRoot);
      const preview = await protocol.newDocumentV2({ ...base, apply: false });
      requireSuccess("preview", preview);
      if (changedPaths(beforePreview, await workspace.fileSnapshot(consumerRoot)).length !== 0) {
        throw new Error("Preview mutated its owned disposable consumer.");
      }
      const previewResult = documentResult(preview);
      const parentBeforeApply = await workspace.parentState(consumerRoot, previewResult.documentPath);
      const recovered = await dependencies.interruptAndRecover({ base, consumerRoot, previewResult, profilePath, protocol });
      const appliedResult = { ...previewResult, receiptDigest: recovered.receiptDigest };
      const applyChanges = changedPaths(beforePreview, await workspace.fileSnapshot(consumerRoot));
      const expectedDirectories = new Set<string>(recovered.receipt.directoryMaterialization?.observedCreatedDirectories ?? []);
      const unexpectedApplyChanges = applyChanges.filter((entry) => {
        const path = entry.slice(entry.indexOf(":") + 1);
        return path !== appliedResult.documentPath &&
          path !== ".agent-teams-local" &&
          !expectedDirectories.has(path) &&
          !path.startsWith(".agent-teams-local") &&
          !path.endsWith("/.foundation-retired-evidence-") &&
          !path.includes("/.foundation-retired-evidence-/");
      });
      if (unexpectedApplyChanges.length > 0) {
        throw new Error(`Apply changed paths outside its exact document and Foundation transaction lifecycle: ${JSON.stringify(unexpectedApplyChanges)}.`);
      }
      if (await workspace.parentState(consumerRoot, appliedResult.documentPath) !== "directory") {
        throw new Error("Apply did not leave a real document parent directory.");
      }
      if (parentBeforeApply === "missing" && recovered.receipt.directoryMaterialization?.state !== "created-and-retained") {
        throw new Error("Missing-parent qualification recovery did not truthfully report retained Plan v2 materialization.");
      }
      await workspace.applyReachability(consumerRoot, appliedResult.reachability);
      const check = await protocol.checkV2({ consumerRoot, profilePath, ...(request.signal === undefined ? {} : { signal: request.signal }) });
      if (check.exitCode !== 0) {throw new Error(`Docs Protocol qualification check failed: ${JSON.stringify(check.envelope)}.`);}
      const doctor = await protocol.doctorV2({ consumerRoot, profilePath, ...(request.signal === undefined ? {} : { signal: request.signal }) });
      requireSuccess("doctor", doctor);
      if (await workspace.snapshot(sourceRoot) !== before) {
        throw new Error("Qualification modified its source fixture.");
      }
      return Object.freeze({
        appliedDocumentPath: appliedResult.documentPath,
        checks: Object.freeze(["info", "find", "preview", "crash", "doctor", "recover", "receipt", "parent", "apply", "index", "check", "source-unchanged"] as const),
        projectId: info.envelope.result.projectId,
        schemaVersion: 1
      });
    } finally {
      await disposable.dispose();
    }
  };
}
