import assert from "node:assert/strict";
import test from "node:test";
import { createDocsTools } from "../dist/index.js";
export const BINDING = Object.freeze({
  consumerRoot: "/fixed/test-consumer",
  profilePath: "config/docs-profile.yml",
});

function execution(command: string, result: unknown, diagnostics: readonly unknown[] = []) {
  return Object.freeze({
    envelope: Object.freeze({
      schemaVersion: 2,
      protocol: Object.freeze({ id: "agent-teams.docs-protocol", version: 1 }),
      command,
      outcome: "success",
      diagnostics: Object.freeze(diagnostics),
      result,
    }),
    exitCode: 0,
  });
}

export function parseResult(result: { content: readonly { type: string; text?: string }[] }) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]!.type, "text");
  return JSON.parse(result.content[0]!.text!);
}

export function registerDiagnosticToolCases() {
  test("tool surface is deterministic and strictly read-only", () => {
    const reader = {
      async info() {
        return execution("docs.info", {});
      },
      async find() {
        return execution("docs.find", { documents: [] });
      },
      async context() {
        return execution("docs.context", { format: "llms.txt", content: "" });
      },
    };
    const tools = createDocsTools(reader, BINDING);

    assert.deepEqual(
      tools.map(({ name }) => name),
      ["docs_info", "docs_find", "docs_context"],
    );
    assert.ok(tools.every(({ annotations }) => annotations.readOnlyHint === true));
    assert.ok(tools.every(({ annotations }) => annotations.destructiveHint === false));
    assert.ok(tools.every(({ annotations }) => annotations.openWorldHint === false));
    assert.ok(tools.every(({ name }) => !/(new|write|recover|upgrade|shell|process)/u.test(name)));
    assert.ok(Object.isFrozen(tools));
  });

  test("unexpected reader errors are sanitized", async () => {
    const reader = {
      async info() {
        throw new Error("secret /private/user/project/config.yml");
      },
      async find() {
        return execution("docs.find", { documents: [] });
      },
      async context() {
        return execution("docs.context", { format: "llms.txt", content: "" });
      },
    };
    const info = createDocsTools(reader, BINDING)[0];

    const result = await info.run({}, new AbortController().signal);
    const payload = parseResult(result);

    assert.equal(result.isError, true);
    assert.equal(payload.error.code, "DOCS_READ_FAILED");
    assert.doesNotMatch(JSON.stringify(result), /secret|private|config\.yml/u);
  });

  test("diagnostic projection reports deterministic scale evidence", async () => {
    const diagnostics = Array.from({ length: 20 }, (_, index) => ({
      ruleId: `rule-${index}`,
      severity: "warning",
      phase: "query",
      subject: `subject-${index}`,
      message: `Message ${index}`,
    }));
    const reader = {
      async info() {
        return execution(
          "docs.info",
          { kind: "info", catalog: { collections: [], excludedPrefixes: [] } },
          diagnostics,
        );
      },
      async find() {
        return execution("docs.find", { documents: [] });
      },
      async context() {
        return execution("docs.context", { format: "llms.txt", content: "" });
      },
    };
    const response = await createDocsTools(reader, BINDING)[0].run(
      {},
      new AbortController().signal,
    );
    const evidence = parseResult(response).diagnostics;
    assert.deepEqual(
      {
        originalCount: evidence.originalCount,
        returnedCount: evidence.returnedCount,
        truncated: evidence.truncated,
      },
      {
        originalCount: 20,
        returnedCount: 8,
        truncated: true,
      },
    );
    assert.deepEqual(
      evidence.items.map(({ ruleId }: { ruleId: string }) => ruleId),
      diagnostics.slice(0, 8).map(({ ruleId }) => ruleId),
    );
  });
}
