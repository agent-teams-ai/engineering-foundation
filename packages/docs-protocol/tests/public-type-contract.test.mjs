import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("portable declarations retain generic result contracts without managed root aliases", async () => {
  const [api, application, root, qualification] = await Promise.all([
    readFile(new URL("../dist/composition/node-docs-api.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/application/docs-protocol.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/qualification/index.d.ts", import.meta.url), "utf8")
  ]);
  assert.match(api, /docsNewV2\(input: DocsNewRequest\): Promise<DocsExecutionV2<DocsNewResultV2>>/u);
  assert.match(application, /newDocumentV2\(request: DocsNewRequest\): Promise<DocsExecutionV2<DocsNewResultV2>>/u);
  assert.match(root, /DocsNewResult, DocsNewRequest/u);
  assert.match(root, /DocsNewResultV2/u);
  assert.match(qualification, /runDocsProtocolQualification/u);
  for (const source of [root, qualification]) {
    assert.doesNotMatch(source, /consumerIntegration|CANONICAL_DOCS_SKILL|QualifiedDocsCohort|runDocsProtocolQualificationV2/u);
  }
});
