import assert from "node:assert/strict";
import type { DocsProtocolApi } from "../../dist/features/docs-command/adapters/inbound/protocol-api.js";
import type { DocumentAuthoringPortV3 } from "../../dist/features/portable-documentation/application/model-v3.js";
import { tenantIntent } from "./protocol-fixtures.ts";
interface PlanCalls {
  readonly apply: number;
  readonly plan: readonly Parameters<DocumentAuthoringPortV3["plan"]>[0][];
}

export async function assertFindFilters(protocol: DocsProtocolApi): Promise<void> {
  const found = await protocol.findV2({
    consumerRoot: ".",
    profilePath: "docs/docs-protocol.json",
    query: { type: "adr", related: "ADR-0001", blockedBy: "ADR-0003" },
  });
  assert.equal(found.exitCode, 0);
  assert.deepEqual(
    found.envelope.result.documents.map(({ id }) => id),
    ["ADR-0002"],
  );
  const empty = await protocol.findV2({
    consumerRoot: ".",
    profilePath: "docs/docs-protocol.json",
    query: { related: "ADR-9999" },
  });
  assert.equal(empty.exitCode, 0);
  assert.equal(empty.envelope.result.matches, 0);
}

export async function assertNewPreview(protocol: DocsProtocolApi, calls: PlanCalls): Promise<void> {
  const result = await protocol.newDocumentV2({
    apply: false,
    consumerRoot: ".",
    profilePath: "docs/docs-protocol.json",
    intent: tenantIntent(),
    related: ["ADR-0001"],
    blockedBy: ["OD-001"],
    codeAnchors: [{ pattern: "src/tenant.ts", enforcement: "required" }],
    additionalMetadata: { evidence: ["test:tenant"] },
  });
  assert.equal(result.envelope.result.writeState, "preview");
  assert.ok(calls.plan[0]);
  assert.equal(result.envelope.result.reservation, "none");
  assert.equal(calls.apply, 0);
  assert.deepEqual(calls.plan[0].intent.additionalMetadata, {
    evidence: ["test:tenant"],
    blocked_by: ["OD-001"],
    code_anchors: [{ enforcement: "required", pattern: "src/tenant.ts" }],
  });
  assert.deepEqual(calls.plan[0].intent.related, ["ADR-0001", "OD-001"]);
  assert.equal(calls.plan[0].parentPolicy, "create-missing-real-directories");
  assert.deepEqual(result.envelope.result.reachability, {
    state: "manual-required",
    indexPath: "docs/decisions/README.md",
    markdownLink: "[ADR-0083: Tenant isolation](0083-tenant-isolation.md)",
  });
}

export async function assertCurrentMethods(current: DocsProtocolApi): Promise<void> {
  const request = {
    apply: false,
    consumerRoot: ".",
    profilePath: "docs/docs-protocol.json",
    intent: tenantIntent(),
  };
  const [richInfo, richNew] = await Promise.all([
    current.infoV2(request),
    current.newDocumentV2(request),
  ]);

  for (const method of ["info", "find", "newDocument", "doctor", "recover", "check"]) {
    assert.equal(typeof Reflect.get(current, method), "undefined");
  }
  assert.equal(richInfo.envelope.schemaVersion, 2);
  assert.deepEqual(richInfo.envelope.result.foundationProfile, {
    metadataSidecarPolicy: "foundation-profile-v3-strict-merge",
    path: "architecture/foundation/document-authoring.yaml",
    schemaVersion: 3,
  });
  assert.deepEqual(
    ["authority", "authorityPaths", "catalog"].map((key) =>
      Object.hasOwn(richInfo.envelope.result, key),
    ),
    [true, true, true],
  );
  assert.deepEqual(richInfo.envelope.result.authority, { templates: [] });
  assert.deepEqual(richInfo.envelope.result.catalog, { collections: [], excludedPrefixes: [] });
  assert.equal(richNew.envelope.schemaVersion, 2);
  assert.ok(richNew.envelope.result.writeState === "preview");
  assert.equal(
    richNew.envelope.result.compiled.document.content.includes("# ADR-0083: Tenant isolation"),
    true,
  );
}
