import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("docsNew declaration is pinned to the public DocsNewResult contract", async () => {
  const [api, application, root] = await Promise.all([
    readFile(new URL("../dist/composition/node-docs-api.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/application/docs-protocol.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8")
  ]);
  assert.match(api, /docsNew\(input: DocsNewRequest\): Promise<DocsExecution<DocsNewResult>>/u);
  assert.match(application, /newDocument\(request: DocsNewRequest\): Promise<DocsExecution<DocsNewResult>>/u);
  assert.match(root, /DocsNewResult/u);
  assert.doesNotMatch(api, /DocsExecution<Readonly<\{\}>>/u);
});
