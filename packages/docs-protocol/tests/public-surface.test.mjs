import assert from "node:assert/strict";
import test from "node:test";

const publicApi = await import("@agent-teams/docs-protocol");
const managedCompatibilityApi = await import(
  "../dist/consumer-integration/composition/canonical-docs-skill-v2.js"
);
const managedAuthorityApi = await import("../dist/consumer-integration/index.js");
const managedAssetAuthorityApi = await import(
  "../dist/consumer-integration/application/policies/consumer-integration-assets.js"
);
const qualificationApi = await import("../dist/qualification/index.js");

const LEGACY_MANAGED_RUNTIME_EXPORTS = [
  "BOOTSTRAP_KNOWN_PRIOR_CALLER_WORKFLOWS",
  "CANONICAL_DOCS_SKILL",
  "ConsumerIntegrationNodeError",
  "applyConsumerIntegration",
  "canonicalCallerWorkflow",
  "canonicalDocsScripts",
  "canonicalDocsScriptsDigest",
  "canonicalManagedRoute",
  "canonicalManagedState",
  "checkConsumerIntegration",
  "describeCanonicalConsumerAssets",
  "planAgentsRouteV1",
  "planConsumerIntegration",
  "planNodeConsumerIntegration",
  "planPnpmManifestV1",
  "readConsumerIntegrationInput",
  "recoverConsumerIntegration",
  "upgradeConsumerIntegration"
];

test("public surface exposes only closed composition and inert protocol constants", () => {
  for (const name of [
    "docsCheck",
    "docsDoctor",
    "docsFind",
    "docsFindV3",
    "docsInfo",
    "docsInitApply",
    "docsInitPlan",
    "docsInitRecover",
    "docsNew",
    "docsProfilePath",
    "docsRecover",
    "renderDocsHumanV3",
    "runDocsCli"
  ]) {
    assert.equal(typeof publicApi[name], "function", name);
  }
  for (const name of ["DocsProtocol", "NodeFoundationDocsPort", "NodeDocsProfileReader", "NodeDocsAdoptionInspector", "NodeCodeAnchorMatcher"]) {
    assert.equal(publicApi[name], undefined, name);
  }
  assert.equal(publicApi.DOCS_PROTOCOL_ID, "agent-teams.docs-protocol");
  assert.equal(publicApi.DOCS_PROTOCOL_VERSION, 1);
  assert.equal(typeof qualificationApi.runDocsProtocolQualification, "function");
});

test("legacy managed root imports resolve through one compatibility facade", () => {
  assert.equal(publicApi.consumerIntegration, managedCompatibilityApi.consumerIntegration);
  assert.equal(managedCompatibilityApi.consumerIntegration, managedAuthorityApi);
  assert.deepEqual(
    Object.keys(publicApi.consumerIntegration).toSorted(),
    LEGACY_MANAGED_RUNTIME_EXPORTS
  );
  for (const name of LEGACY_MANAGED_RUNTIME_EXPORTS) {
    assert.equal(publicApi.consumerIntegration[name], managedAuthorityApi[name], name);
  }
  assert.equal(typeof publicApi.CANONICAL_DOCS_SKILL_V2, "string");
  assert.equal(
    publicApi.CANONICAL_DOCS_SKILL_V2,
    managedCompatibilityApi.CANONICAL_DOCS_SKILL_V2
  );
  assert.equal(
    managedCompatibilityApi.CANONICAL_DOCS_SKILL_V2,
    managedAssetAuthorityApi.CANONICAL_DOCS_SKILL_V2
  );
  assert.equal("CANONICAL_DOCS_SKILL_V2" in publicApi.consumerIntegration, false);
});
