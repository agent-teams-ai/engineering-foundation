import assert from "node:assert/strict";
import test from "node:test";
import {
  checkBudgets,
  checkFindings,
  formatBaseline,
  formatBudgetAnnotations,
  initBaseline,
  parseBaseline,
  pruneBaseline,
} from "../packages/engineering-foundation/dist/ratchet.js";

const namespace = "oxlint";
const size = { path: "src/big.ts", rule: "oxlint/eslint/max-lines", count: 1, max: 612 };
const style = { path: "src/a.ts", rule: "oxlint/typescript/method-signature-style", count: 3 };
const baseline = [size, style];
const kinds = (violations) => violations.map(({ kind, path, rule }) => `${kind} ${path} ${rule}`);

test("baseline rejects a new, a raised and a stale entry and accepts equal findings", () => {
  assert.deepEqual(checkFindings({ baseline, observed: baseline, namespace }), []);
  const added = { path: "src/new.ts", rule: "oxlint/eslint/max-params", count: 1, max: 6 };
  assert.deepEqual(kinds(checkFindings({ baseline, observed: [...baseline, added], namespace })), [
    "new src/new.ts oxlint/eslint/max-params",
  ]);
  assert.deepEqual(
    kinds(checkFindings({ baseline, observed: [{ ...size, max: 613 }, style], namespace })),
    ["worse src/big.ts oxlint/eslint/max-lines"],
  );
  assert.deepEqual(
    kinds(checkFindings({ baseline, observed: [size, { ...style, count: 4 }], namespace })),
    ["worse src/a.ts oxlint/typescript/method-signature-style"],
  );
  assert.deepEqual(
    kinds(checkFindings({ baseline, observed: [size, { ...style, count: 2 }], namespace })),
    ["stale src/a.ts oxlint/typescript/method-signature-style"],
  );
  assert.deepEqual(kinds(checkFindings({ baseline, observed: [size], namespace })), [
    "stale src/a.ts oxlint/typescript/method-signature-style",
  ]);
  assert.deepEqual(
    kinds(checkFindings({ baseline, observed: [{ ...size, max: 500 }, style], namespace })),
    ["stale src/big.ts oxlint/eslint/max-lines"],
  );
});

test("prune only lowers and removes, and a producer verifies only its own namespace", () => {
  const foreign = { path: "src/a.ts", rule: "fms/visibility", count: 2 };
  const all = [...baseline, foreign];
  const observed = [
    { ...size, max: 540 },
    { path: "src/new.ts", rule: "oxlint/eslint/max-params", count: 1, max: 6 },
  ];
  assert.deepEqual(
    checkFindings({ baseline: all, observed: [], namespace }).map(({ kind }) => kind),
    ["stale", "stale"],
  );
  const pruned = pruneBaseline({ baseline: all, observed, namespace });
  assert.deepEqual(pruned.entries, [foreign, { ...size, max: 540 }]);
  assert.equal(pruned.lowered, 1);
  assert.equal(pruned.removed, 1);
  assert.deepEqual(kinds(pruned.remaining), ["new src/new.ts oxlint/eslint/max-params"]);
  const worse = pruneBaseline({
    baseline,
    observed: [{ ...size, count: 2, max: 700 }, style],
    namespace,
  });
  assert.deepEqual(
    worse.entries.find(({ path }) => path === size.path),
    size,
  );
  assert.deepEqual(kinds(worse.remaining), ["worse src/big.ts oxlint/eslint/max-lines"]);
  assert.throws(
    () => checkFindings({ baseline, observed: [foreign], namespace }),
    /outside the oxlint namespace/u,
  );
});

test("prune drops a recorded maximum once the finding no longer carries one", () => {
  const pruned = pruneBaseline({
    baseline: [size],
    observed: [{ path: size.path, rule: size.rule, count: 1 }],
    namespace,
  });
  assert.deepEqual(pruned.entries, [{ path: size.path, rule: size.rule, count: 1 }]);
  assert.equal(pruned.lowered, 1);
  assert.deepEqual(pruned.remaining, []);
});

test("init refuses over an existing baseline", () => {
  assert.deepEqual(initBaseline({ observed: [size, style] }), [style, size]);
  assert.throws(
    () => initBaseline({ observed: baseline, existing: formatBaseline(baseline) }),
    /already exists/u,
  );
});

test("baseline text is canonical and hand edits that reorder, duplicate or widen it are rejected", () => {
  const text = formatBaseline(baseline);
  assert.deepEqual(parseBaseline(text), [style, size]);
  const lines = text.split("\n");
  assert.throws(
    () => parseBaseline([lines[0], lines[2], lines[1], ""].join("\n")),
    /not canonical/u,
  );
  assert.throws(
    () => parseBaseline([lines[0], lines[1], lines[1], ""].join("\n")),
    /Duplicate|not canonical/u,
  );
  assert.throws(() => parseBaseline(text.slice(0, -1)), /newline/u);
  assert.throws(
    () =>
      parseBaseline(
        `${lines[0]}\n{"path":"a.ts","rule":"oxlint/x","count":1,"expires":"2027-01-01"}\n`,
      ),
    /unexpected fields/u,
  );
  assert.throws(
    () => formatBaseline([{ path: "../a.ts", rule: "oxlint/x", count: 1 }]),
    /repository-relative/u,
  );
  assert.throws(
    () => formatBaseline([{ path: "a.ts", rule: "no-namespace", count: 1 }]),
    /namespace/u,
  );
  assert.throws(
    () => formatBaseline([{ path: "a.ts", rule: "oxlint/x", count: 0 }]),
    /positive integer/u,
  );
});

test("budgets only warn, prefer a subject threshold and escape annotations", () => {
  const warnings = checkBudgets({
    measurements: [
      { subject: "src/a", metric: "files", value: 12 },
      { subject: "src/b", metric: "files", value: 12 },
      { subject: "src/c", metric: "depth", value: 2 },
    ],
    thresholds: [
      { metric: "files", max: 10 },
      { metric: "files", subject: "src/b", max: 20 },
      { metric: "depth", max: 3 },
    ],
  });
  assert.deepEqual(warnings, [{ subject: "src/a", metric: "files", value: 12, max: 10 }]);
  assert.equal(
    formatBudgetAnnotations([{ subject: "a,b\n%", metric: "m:x", value: 2, max: 1 }]),
    "::warning title=m%3Ax budget::a,b%0A%25: m:x is 2, budget 1\n",
  );
});

test("budgets reject a duplicate threshold and non-finite numbers", () => {
  const measurements = [{ subject: "src/a", metric: "files", value: 12 }];
  assert.throws(
    () =>
      checkBudgets({
        measurements,
        thresholds: [
          { metric: "files", max: 10 },
          { metric: "files", max: 20 },
        ],
      }),
    /more than once/u,
  );
  assert.throws(
    () =>
      checkBudgets({
        measurements,
        thresholds: [
          { metric: "files", subject: "src/a", max: 1 },
          { metric: "files", subject: "src/a", max: 2 },
        ],
      }),
    /more than once/u,
  );
  assert.throws(
    () => checkBudgets({ measurements, thresholds: [{ metric: "files", max: Number.NaN }] }),
    /finite/u,
  );
  assert.throws(
    () =>
      checkBudgets({
        measurements: [{ ...measurements[0], value: Number.POSITIVE_INFINITY }],
        thresholds: [],
      }),
    /finite/u,
  );
  assert.deepEqual(
    checkBudgets({
      measurements,
      thresholds: [
        { metric: "files", max: 10 },
        { metric: "files", subject: "src/a", max: 20 },
      ],
    }),
    [],
  );
});
