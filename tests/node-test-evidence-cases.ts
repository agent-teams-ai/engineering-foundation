import assert from "node:assert/strict";
import test from "node:test";
import { mandatoryTestFile } from "../scripts/mandatory-node-test-gate-fixture.mjs";
import {
  assertSupportedNodeTestRuntime,
  evaluateNodeTestEvents,
  validateNodeTestContract,
} from "../packages/engineering-foundation/dist/capabilities/quality-gate-runner/adapters/inbound/node-test-execution/runner.js";

type Event = Parameters<typeof evaluateNodeTestEvents>[0][number];
export const identity = (file: string, names: readonly string[], kind = "test") => ({
  file,
  names,
  kind,
});
export const contract = (required: readonly unknown[], exceptions: readonly unknown[] = []) => ({
  schemaVersion: 1,
  required,
  exceptions,
});
export const exception = (
  item: ReturnType<typeof identity>,
  status: string,
  platform: string = process.platform,
) => ({
  ...item,
  status,
  reason: "Reviewed fixture exception for the exact required case.",
  applicability: { platforms: [platform] },
});
export const testFile = mandatoryTestFile;
const selected: [{ absolute: string; file: string }] = [
  { absolute: "/fixture/cases.test.mjs", file: testFile },
];
const event = (
  type: string,
  id: number,
  parentId: number,
  name: string,
  kind = "test",
  other: Record<string, unknown> = {},
) => ({
  type,
  data: {
    entryFile: selected[0].absolute,
    file: selected[0].absolute,
    testId: id,
    parentId,
    name,
    ...(type === "test:enqueue" ? { type: kind } : { details: { type: kind, passed: true } }),
    ...other,
  },
});
const successfulEvents = (nodes: readonly ReturnType<typeof node>[]): Event[] => [
  ...nodes.flatMap(({ id, parentId = 0, name, kind = "test", outcome = "pass" }) => [
    event("test:enqueue", id, parentId, name, kind),
    event("test:complete", id, parentId, name, kind, outcome === "pass" ? {} : { [outcome]: true }),
    event("test:pass", id, parentId, name, kind, outcome === "pass" ? {} : { [outcome]: true }),
  ]),
  { type: "test:summary", data: { entryFile: selected[0].absolute, success: true } },
  { type: "test:summary", data: { success: true } },
];
const node = (id: number, name: string, parentId = 0, kind = "test", outcome = "pass") => ({
  id,
  name,
  parentId,
  kind,
  outcome,
});

function registerContractRuntimeCases(): void {
  void test("contract rejects empty, ambiguous, broad and malformed authority", () => {
    const item = identity(testFile, ["required"]);
    assert.throws(() => validateNodeTestContract(contract([])), /nonempty/);
    assert.throws(() => validateNodeTestContract(contract([item, item])), /duplicate/);
    assert.throws(
      () =>
        validateNodeTestContract(
          contract([item], [exception(item, "skipped"), exception(item, "skipped")]),
        ),
      /ambiguous/,
    );
    assert.throws(
      () =>
        validateNodeTestContract(
          contract(
            [item],
            [
              {
                ...exception(item, "skipped"),
                applicability: { platforms: ["linux", "darwin", "win32"] },
              },
            ],
          ),
        ),
      /platform subset/,
    );
    assert.throws(
      () => validateNodeTestContract(contract([identity("../escape", ["required"])])),
      /normalized/,
    );
    assert.throws(
      () => validateNodeTestContract(contract([item], [exception(item, "failed")])),
      /exact status/,
    );
  });

  void test("mandatory command keeps Node 24 default and accepts the Node 26 compatibility lane", () => {
    assert.throws(
      () => assertSupportedNodeTestRuntime("24.18.0"),
      /Node >=24\.21\.0 <25 or >=26\.0\.0 <27/,
    );
    assert.throws(
      () => assertSupportedNodeTestRuntime("24.20.0"),
      /Node >=24\.21\.0 <25 or >=26\.0\.0 <27/,
    );
    assert.throws(
      () => assertSupportedNodeTestRuntime("23.99.0"),
      /Node >=24\.21\.0 <25 or >=26\.0\.0 <27/,
    );
    assert.throws(
      () => assertSupportedNodeTestRuntime("25.0.0"),
      /Node >=24\.21\.0 <25 or >=26\.0\.0 <27/,
    );
    assert.throws(
      () => assertSupportedNodeTestRuntime("27.0.0"),
      /Node >=24\.21\.0 <25 or >=26\.0\.0 <27/,
    );
    assert.doesNotThrow(() => assertSupportedNodeTestRuntime("24.21.0"));
    assert.doesNotThrow(() => assertSupportedNodeTestRuntime("26.0.0"));
    assert.doesNotThrow(() => assertSupportedNodeTestRuntime("26.10.0"));
  });
}

function registerCompletionEvidenceCases(): void {
  void test("event evidence needs unique completion, result, ancestry and selected file", () => {
    const required = identity(testFile, ["parent", "child"]);
    const nodes = [node(1, "parent"), node(2, "child", 1)];
    assert.equal(
      evaluateNodeTestEvents(successfulEvents(nodes), contract([required]), selected)
        .protectedCount,
      1,
    );
    assert.throws(
      () =>
        evaluateNodeTestEvents(
          successfulEvents(nodes).filter(
            (e) => e.type !== "test:complete" || e.data?.name !== "child",
          ),
          contract([required]),
          selected,
        ),
      /lacks completion/,
    );
    assert.throws(
      () =>
        evaluateNodeTestEvents(
          successfulEvents([...nodes, node(3, "child", 1)]),
          contract([required]),
          selected,
        ),
      /ambiguous duplicate identity/,
    );
    assert.throws(
      () =>
        evaluateNodeTestEvents(
          [successfulEvents(nodes)[0]!, ...successfulEvents(nodes)],
          contract([required]),
          selected,
        ),
      /duplicate or malformed enqueue/,
    );
    assert.throws(
      () =>
        evaluateNodeTestEvents(
          successfulEvents(nodes).map((e) =>
            e.type === "test:complete" && e.data?.name === "child"
              ? { ...e, data: { ...e.data, testId: "2" } }
              : e,
          ),
          contract([required]),
          selected,
        ),
      /malformed/,
    );
    assert.throws(
      () =>
        evaluateNodeTestEvents(
          successfulEvents([node(2, "child", 1)]),
          contract([required]),
          selected,
        ),
      /missing test or suite ancestry/,
    );
    assert.throws(
      () =>
        evaluateNodeTestEvents(
          successfulEvents(nodes).map((e) =>
            e.data?.name === "child"
              ? { ...e, data: { ...e.data, entryFile: "/foreign/cases.test.mjs" } }
              : e,
          ),
          contract([required]),
          selected,
        ),
      /unselected/,
    );
  });

  void test("a failed result and an unsuccessful native summary always reject", () => {
    const required = identity(testFile, ["failed"]);
    const events = successfulEvents([node(1, "failed")]).map((item) => {
      if (item.type === "test:summary") {
        return { ...item, data: { ...item.data, success: false } };
      }
      if (item.type === "test:pass") {
        return { ...item, type: "test:fail" };
      }
      if (item.type === "test:complete") {
        return { ...item, data: { ...item.data, details: { type: "test", passed: false } } };
      }
      return item;
    });
    assert.throws(() => evaluateNodeTestEvents(events, contract([required]), selected), /failed/);
    assert.throws(
      () =>
        evaluateNodeTestEvents(
          successfulEvents([node(1, "failed")]).map((item) =>
            item.type === "test:summary"
              ? { ...item, data: { ...item.data, success: false } }
              : item,
          ),
          contract([required]),
          selected,
        ),
      /unsuccessful/,
    );
  });

  void test("expected-failure evidence rejects even with passing completion and summaries", () => {
    const required = identity(testFile, ["required"]);
    const ordinary = successfulEvents([node(1, "required")]);
    assert.equal(
      evaluateNodeTestEvents(ordinary, contract([required]), selected).protectedCount,
      1,
    );
    for (const type of ["test:enqueue", "test:complete", "test:pass"]) {
      for (const value of [true, "reviewed failure"]) {
        const expectedFailure = ordinary.map((item) =>
          item.type === type ? { ...item, data: { ...item.data, expectFailure: value } } : item,
        );
        assert.throws(
          () => evaluateNodeTestEvents(expectedFailure, contract([required]), selected),
          /expected failure/,
        );
      }
      for (const malformed of [null, undefined, 0, 1, {}, []]) {
        const invalid = successfulEvents([node(1, "required"), node(2, "unrelated")]).map((item) =>
          item.type === type && item.data?.name === "unrelated"
            ? { ...item, data: { ...item.data, expectFailure: malformed } }
            : item,
        );
        assert.throws(
          () => evaluateNodeTestEvents(invalid, contract([required]), selected),
          /malformed expectFailure directive/,
        );
      }
    }
    const inactive = ordinary.map((item) =>
      item.type === "test:pass" ? { ...item, data: { ...item.data, expectFailure: false } } : item,
    );
    assert.equal(
      evaluateNodeTestEvents(inactive, contract([required]), selected).protectedCount,
      1,
    );
    const child = identity(testFile, ["parent", "child"]);
    const inherited = successfulEvents([node(1, "parent"), node(2, "child", 1)]).map((item) =>
      item.type === "test:pass" && item.data?.name === "parent"
        ? { ...item, data: { ...item.data, expectFailure: true } }
        : item,
    );
    assert.throws(
      () => evaluateNodeTestEvents(inherited, contract([child]), selected),
      /expected failure/,
    );
    assert.throws(
      () =>
        evaluateNodeTestEvents(inherited, contract([child], [exception(child, "todo")]), selected),
      /expected failure/,
    );
    const malformedSummary = ordinary.map((item) =>
      item.type === "test:summary"
        ? { ...item, data: { ...item.data, expectFailure: null } }
        : item,
    );
    assert.throws(
      () => evaluateNodeTestEvents(malformedSummary, contract([required]), selected),
      /malformed expectFailure directive/,
    );
  });
}

function registerDirectiveEvidenceCases(): void {
  void test("nested, skip, TODO and omissions fail unless an exact applicable exception exists", () => {
    const child = identity(testFile, ["parent", "child"]);
    assert.throws(
      () =>
        evaluateNodeTestEvents(
          successfulEvents([node(1, "parent"), node(2, "child", 1, "test", "skip")]),
          contract([child]),
          selected,
        ),
      /skipped/,
    );
    assert.throws(
      () =>
        evaluateNodeTestEvents(
          successfulEvents([node(1, "parent"), node(2, "child", 1, "test", "todo")]),
          contract([child]),
          selected,
        ),
      /todo/,
    );
    assert.throws(
      () =>
        evaluateNodeTestEvents(
          successfulEvents([node(1, "parent"), node(2, "unrelated", 1)]),
          contract([child]),
          selected,
        ),
      /omitted/,
    );
    assert.throws(
      () =>
        evaluateNodeTestEvents(
          successfulEvents([node(1, "parent", 0, "suite", "skip")]),
          contract([child], [exception(child, "omitted")]),
          selected,
        ),
      /unexecuted ancestor/,
    );
    assert.equal(
      evaluateNodeTestEvents(
        successfulEvents([node(1, "parent"), node(2, "child", 1, "test", "skip")]),
        contract([child], [exception(child, "skipped")]),
        selected,
      ).protectedCount,
      1,
    );
    assert.throws(
      () =>
        evaluateNodeTestEvents(
          successfulEvents([node(1, "parent"), node(2, "child", 1, "test", "skip")]),
          contract([child], [exception(child, "skipped", "unsupported")]),
          selected,
        ),
      /platform subset/,
    );
    assert.throws(
      () =>
        evaluateNodeTestEvents(
          successfulEvents([node(1, "parent")]),
          contract([identity("other.test.mjs", ["parent"])]),
          selected,
        ),
      /no mandatory identities/,
    );
    assert.equal(
      evaluateNodeTestEvents(
        successfulEvents([node(1, "parent")]),
        contract([identity(testFile, ["parent"]), identity("other.test.mjs", ["other"])]),
        selected,
      ).protectedCount,
      1,
    );
  });

  void test("directive evidence accepts empty strings and rejects malformed values across observed entries", () => {
    const required = identity(testFile, ["required"]);
    for (const directive of ["skip", "todo"]) {
      const status = directive === "skip" ? "skipped" : "todo";
      const events = successfulEvents([node(1, "required")]).map((item) =>
        item.type === "test:pass" ? { ...item, data: { ...item.data, [directive]: "" } } : item,
      );
      assert.throws(
        () => evaluateNodeTestEvents(events, contract([required]), selected),
        new RegExp(status),
      );
      assert.equal(
        evaluateNodeTestEvents(
          events,
          contract([required], [exception(required, status)]),
          selected,
        ).protectedCount,
        1,
      );
      for (const type of ["test:enqueue", "test:complete", "test:pass"]) {
        for (const malformed of [null, undefined, 0, 1, {}, []]) {
          const invalid = successfulEvents([node(1, "required"), node(2, "unrelated")]).map(
            (item) =>
              item.type === type && item.data?.name === "unrelated"
                ? { ...item, data: { ...item.data, [directive]: malformed } }
                : item,
          );
          assert.throws(
            () => evaluateNodeTestEvents(invalid, contract([required]), selected),
            /malformed .* directive/,
          );
        }
      }
    }
    const inactive = successfulEvents([node(1, "required")]).map((item) =>
      item.type === "test:pass"
        ? { ...item, data: { ...item.data, skip: false, todo: false } }
        : item,
    );
    assert.equal(
      evaluateNodeTestEvents(inactive, contract([required]), selected).protectedCount,
      1,
    );
    const enqueueSkip = successfulEvents([node(1, "required")]).map((item) =>
      item.type === "test:enqueue" ? { ...item, data: { ...item.data, skip: "" } } : item,
    );
    assert.throws(
      () => evaluateNodeTestEvents(enqueueSkip, contract([required]), selected),
      /skipped/,
    );
    const conflicting = successfulEvents([node(1, "required"), node(2, "unrelated")]).map((item) =>
      item.data?.name === "unrelated" && item.type === "test:complete"
        ? { ...item, data: { ...item.data, skip: "" } }
        : item.data?.name === "unrelated" && item.type === "test:pass"
          ? { ...item, data: { ...item.data, todo: "" } }
          : item,
    );
    assert.throws(
      () => evaluateNodeTestEvents(conflicting, contract([required]), selected),
      /conflicting/,
    );
    const malformedSummary = successfulEvents([node(1, "required")]).map((item) =>
      item.type === "test:summary" ? { ...item, data: { ...item.data, skip: null } } : item,
    );
    assert.throws(
      () => evaluateNodeTestEvents(malformedSummary, contract([required]), selected),
      /malformed skip directive/,
    );
    const skippedWrapper = [
      {
        type: "test:pass",
        data: { file: selected[0].absolute, name: selected[0].absolute, parentId: 0, skip: "" },
      },
      ...successfulEvents([node(1, "required")]),
    ];
    assert.throws(
      () => evaluateNodeTestEvents(skippedWrapper, contract([required]), selected),
      /directive outside a test identity/,
    );
  });

  void test("empty-reason directive on a required ancestor prevents descendant qualification", () => {
    const child = identity(testFile, ["parent", "child"]);
    const events = successfulEvents([node(1, "parent"), node(2, "child", 1)]).map((item) =>
      item.type === "test:pass" && item.data?.name === "parent"
        ? { ...item, data: { ...item.data, skip: "" } }
        : item,
    );
    assert.throws(
      () => evaluateNodeTestEvents(events, contract([child]), selected),
      /unexecuted ancestor/,
    );
  });
}

export function registerNodeTestEvidenceCases(): void {
  registerContractRuntimeCases();
  registerCompletionEvidenceCases();
  registerDirectiveEvidenceCases();
}
