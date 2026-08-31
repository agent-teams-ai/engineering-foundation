import assert from "node:assert/strict";
import test from "node:test";

const publicApi = await import("@agent-teams/docs-protocol");
const qualificationApi = await import("@agent-teams/docs-protocol/qualification");

const FORBIDDEN_MANAGED_EXPORTS = [
  "CANONICAL_DOCS_SKILL",
  "CANONICAL_DOCS_SKILL_V2",
  "applyConsumerIntegration",
  "checkConsumerIntegration",
  "consumerIntegration",
  "planConsumerIntegration",
  "recoverConsumerIntegration",
  "runDocsProtocolQualificationV2",
  "upgradeConsumerIntegration"
];
const FORBIDDEN_LEGACY_ROOT_EXPORTS = [
  "docsCheck",
  "docsContext",
  "docsDoctor",
  "docsFind",
  "docsInfo",
  "docsNew",
  "docsRecover",
  "renderDocsHuman"
];

test("portable public surface exposes generic commands, recovery, and MCP-facing APIs", () => {
  for (const name of [
    "docsCheckV2",
    "docsContextV1",
    "docsDoctorV2",
    "docsFindV2",
    "docsFindV3",
    "docsInfoV2",
    "docsInitApply",
    "docsInitPlan",
    "docsInitRecover",
    "docsNewV2",
    "docsProfilePath",
    "docsRecoverV2",
    "renderDocsHumanV3",
    "runDocsCli"
  ]) {
    assert.equal(typeof publicApi[name], "function", name);
  }
  assert.equal(publicApi.DOCS_PROTOCOL_ID, "agent-teams.docs-protocol");
  assert.equal(publicApi.DOCS_PROTOCOL_VERSION, 1);
  assert.equal(typeof qualificationApi.runDocsProtocolQualification, "function");
});

test("portable public surface has no managed compatibility facade or Cohort authority", () => {
  for (const name of FORBIDDEN_MANAGED_EXPORTS) {
    assert.equal(publicApi[name], undefined, name);
    assert.equal(qualificationApi[name], undefined, name);
  }
  for (const name of FORBIDDEN_LEGACY_ROOT_EXPORTS) {
    assert.equal(publicApi[name], undefined, name);
  }
});
