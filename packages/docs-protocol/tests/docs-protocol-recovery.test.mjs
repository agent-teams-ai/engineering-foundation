import { DocsProtocol } from "../dist/features/portable-documentation/application/docs-protocol.js";
import { YamlCompiledOutputReader } from "../dist/features/portable-documentation/adapters/outbound/yaml-compiled-output-reader.js";
import { createCommunityMiniSearchIndex } from "../dist/features/portable-documentation/adapters/outbound/minisearch-adapter.js";
import assert from "node:assert/strict";
import test from "node:test";

import { createDocsProtocolApi } from "../dist/features/docs-command/adapters/inbound/protocol-api.js";

test("doctor preserves transaction diagnostics and recover ignores mutable profiles", async () => {
  let profileReads = 0;
  let transactionFormat = "document-authoring-envelope-v3";
  const recoveryReceipt = {
    schemaVersion: 2,
    protocolVersion: 2,
    planDigest: `sha256:${"3".repeat(64)}`,
    adapter: { id: "foundation.filesystem/v1", contractVersion: 1 },
    destination: "docs/decisions/generated/0002-recovery.md",
    outcome: "applied",
    resultDigest: `sha256:${"4".repeat(64)}`,
    commit: { state: "committed", publication: "published", fileAtomicity: "single-file-atomic-create", recoverability: "not-required" },
    directoryMaterialization: { state: "created-and-retained", plannedDirectories: ["docs/decisions/generated"], observedCreatedDirectories: ["docs/decisions/generated"] },
    diagnostics: [],
    receiptDigest: `sha256:${"5".repeat(64)}`
  };
  const foundation = {
    async inspectEnvironment() {
      return { installedFoundationVersion: "0.17.0-rc.0", installedFoundationBuildIdentity: `sha256:${"1".repeat(64)}`, filesystem: { basis: "platform-contract", strictDirectoryDurability: "platform-supported" } };
    },
    async inspect() {
      return { schemaVersion: 2, state: "recoverable", operationKind: "document-authoring", format: transactionFormat, foundationVersion: "0.17.0-rc.0", foundationBuildIdentity: `sha256:${"1".repeat(64)}`, recovery: { commandId: "docs-recover", exactFoundationVersion: "0.17.0-rc.0", exactFoundationBuildIdentity: `sha256:${"1".repeat(64)}` }, diagnostics: [] };
    },
    async recover() { return recoveryReceipt; }
  };
  const protocol = createDocsProtocolApi(new DocsProtocol({ compiledOutput: new YamlCompiledOutputReader(), searchIndex: createCommunityMiniSearchIndex(),
    adoption: { async inspect() { return []; } },
    anchors: { async matchedPatterns() { return []; } },
    foundation,
    profiles: { async read() { profileReads += 1; throw new Error("corrupt profile"); } }
  }));
  const doctor = await protocol.doctorV2({ consumerRoot: ".", profilePath: "architecture/foundation/docs-protocol.yaml" });
  assert.equal(doctor.envelope.outcome, "recovery-required");
  assert.equal(doctor.envelope.result.transaction.state, "recoverable");
  assert.match(doctor.envelope.diagnostics[0].message, /corrupt profile/u);

  transactionFormat = "document-authoring-envelope-v4";
  const v4Doctor = await protocol.doctorV2({ consumerRoot: ".", profilePath: "architecture/foundation/docs-protocol.yaml" });
  assert.equal(v4Doctor.envelope.result.transaction.state, "recoverable");

  const recovered = await protocol.recoverV2({ consumerRoot: ".", profilePath: "architecture/foundation/docs-protocol.yaml" });
  assert.equal(recovered.exitCode, 0);
  assert.equal(recovered.envelope.result.writeState, "committed");
  assert.equal(recovered.envelope.result.receipt.commit.publication, "published");
  assert.equal(profileReads, 2, "recover must not reread mutable profiles after either doctor inspection");
});
