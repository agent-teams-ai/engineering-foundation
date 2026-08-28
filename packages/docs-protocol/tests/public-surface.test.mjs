import assert from "node:assert/strict";
import test from "node:test";

const publicApi = await import("../dist/index.js");
const qualificationApi = await import("../dist/qualification/index.js");

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
