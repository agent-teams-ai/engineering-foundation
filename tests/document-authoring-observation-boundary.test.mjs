import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { CapabilityInputError, ContainedFileReadError } from "../packages/document-authoring/dist/documentation-observation/api.js";
import { assertDocumentAuthoringActive, createDocumentInputFailure, isDocumentInputFailure } from "../packages/document-authoring/dist/document-authoring/application/policies/document-input-failure.js";
import { isDocumentFileReadFailure } from "../packages/document-authoring/dist/document-authoring/application/policies/document-file-read-failure.js";
import { readDocumentAuthorityFile } from "../packages/document-authoring/dist/document-authoring/adapters/node/read-document-authority-file.js";
import { parseStrictYamlSource } from "../packages/document-authoring/dist/document-authoring/adapters/node/strict-yaml.js";

test("authoring input boundary retains provider error identity and rejects lookalikes", () => {
  const error = createDocumentInputFailure("SCHEMA_INVALID", "Invalid input.", "catalog");
  assert.ok(error instanceof CapabilityInputError);
  assert.deepEqual(error.problem, { code: "SCHEMA_INVALID", message: "Invalid input.", phase: "catalog", retryable: false });
  assert.equal(isDocumentInputFailure(error), true);
  assert.equal(isDocumentInputFailure(Object.assign(new Error(error.message), { problem: error.problem })), false);
  assert.equal(isDocumentInputFailure(null), false);
  assert.throws(() => parseStrictYamlSource("key: &value yes\nref: *value\n", "template"), (failure) => {
    assert.ok(failure instanceof CapabilityInputError);
    assert.equal(failure.problem.code, "YAML_FEATURE_PROHIBITED");
    assert.equal(failure.problem.phase, "template");
    return true;
  });
});

test("authoring cancellation preserves the established public error", () => {
  assert.doesNotThrow(() => assertDocumentAuthoringActive());
  const controller = new AbortController();
  assert.doesNotThrow(() => assertDocumentAuthoringActive(controller.signal));
  controller.abort();
  assert.throws(() => assertDocumentAuthoringActive(controller.signal), (error) => {
    assert.ok(error instanceof CapabilityInputError);
    assert.deepEqual(error.problem, { code: "EXECUTION_CANCELLED", message: "Document authoring was cancelled.", phase: "execution", retryable: false });
    return true;
  });
});

for (const failure of ["changed", "escape", "invalid", "missing", "symlink", "unavailable"]) {
  test(`authoring file boundary preserves ${failure} identity, cause and selected read request`, async () => {
    const cause = new ContainedFileReadError(failure);
    const calls = [];
    const root = resolve("sandbox-authoring-fixture");
    assert.equal(isDocumentFileReadFailure(cause), true);
    await assert.rejects(readDocumentAuthorityFile(async (request) => {
      calls.push(request);
      throw cause;
    }, { consumerRoot: root, maxBytes: 64, path: "docs/authority.yaml" }), (error) => {
      assert.equal(error.code, "DOCUMENT_CATALOG_AUTHORITY_UNAVAILABLE");
      assert.equal(error.cause, cause);
      return true;
    });
    assert.deepEqual(calls, [{ candidate: resolve(root, "docs/authority.yaml"), maxBytes: 64, root }]);
  });
}

test("authoring file boundary does not reinterpret foreign failures", async () => {
  const foreign = Object.assign(new Error("foreign"), { failure: "missing" });
  assert.equal(isDocumentFileReadFailure(foreign), false);
  await assert.rejects(readDocumentAuthorityFile(async () => { throw foreign; }, {
    consumerRoot: resolve("sandbox-authoring-fixture"), maxBytes: 64, path: "docs/authority.yaml"
  }), (error) => error === foreign);
});
