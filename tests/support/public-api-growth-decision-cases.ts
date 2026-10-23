import { createHash } from "node:crypto";
import {
  evaluateGrowthAdmission,
  growthDecisionDigest,
} from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/evaluate-growth-admission.js";
import type {
  GrowthTransition,
  GrowthDecision,
  GrowthComparison,
  GrowthAdmissionResult,
} from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-admission.js";
import {
  growthDimensions,
  type GrowthDigest,
  type GrowthCoordinate,
  type GrowthSurfaceObservation,
} from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-observation.js";
import { normalizeGrowthObservation } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/normalize-growth-observation.js";
import assert from "node:assert/strict";
import test from "node:test";
import { isGrowthDecision } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-growth-decision.js";
import {
  compareGrowthSurfaces,
  growthTransitionFingerprint,
  growthGroupFingerprint,
} from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/compare-growth-surfaces.js";
export const otherDigest: GrowthDigest = `sha256:${"b".repeat(64)}`;
export const digest: GrowthDigest = `sha256:${"a".repeat(64)}`;
export const coordinate = (symbol = "A", exportPath = "."): GrowthCoordinate => ({
  packageName: "example",
  exportPath,
  resolutionBranch: [],
  subject: { kind: "typed", canonicalReference: symbol },
});
export const entry = (
  symbol: string,
  value: GrowthDigest = digest,
  path = ".",
): GrowthSurfaceObservation["entries"][number] => ({
  coordinate: coordinate(symbol, path),
  value: { state: "present", digest: value },
});
export const observation = (
  entries: GrowthSurfaceObservation["entries"],
): GrowthSurfaceObservation => ({
  contractRevision: "foundation:sdk-growth:c0:5",
  observationVersion: "foundation:sdk-growth:observation:1",
  repository: "fixture",
  sourceCommit: "a".repeat(40),
  sourceTree: "b".repeat(40),
  topologyDigest: digest,
  lockDigest: digest,
  toolchainDigest: digest,
  artifactDigests: [digest],
  tool: { version: "1", artifactDigest: digest, extractorVersion: "pinned" },
  coverage: [
    {
      packageName: "example",
      classification: "governed",
      dimensions: growthDimensions.map((dimension) => ({
        dimension,
        status: dimension === "decision" ? "unavailable" : "complete",
        reasons: [dimension === "decision" ? "s2-pending" : "fixture-observed"],
      })),
    },
  ],
  entries,
});
const completeComparison = (
  before: GrowthSurfaceObservation["entries"],
  after: GrowthSurfaceObservation["entries"],
) => {
  const result = compare(before, after);
  assert.ok(result.status === "complete");
  return result;
};
export const policyVersion = "foundation:sdk-growth:policy:1";
export const fingerprint = {
  sha256(value: string) {
    return createHash("sha256").update(value).digest("hex");
  },
};
export const valid = (): Record<string, unknown> => ({
  contractRevision: "foundation:sdk-growth:c0:5",
  decisionId: "ADR-1",
  ownerRef: "owner/team",
  stability: "supported",
  transitions: [digest],
  coordinates: [
    { packageName: "example", exportPath: ".", resolutionBranch: [], subject: { kind: "package" } },
  ],
  changeFingerprint: digest,
  consumerEvidenceRefs: [
    {
      useCase: "test",
      repository: "consumer",
      source: { tree: "a".repeat(40), contentDigest: digest, commit: null },
      artifactDigest: null,
    },
  ],
  exposureRationale: "consumer use",
  compatibilityRationale: "additive",
  lifecycle: { kind: "ordinary" },
});
function validDecision(): GrowthDecision {
  const value = valid();
  assert.ok(isGrowthDecision(value));
  return value;
}
export const compare = (
  before: GrowthSurfaceObservation["entries"],
  after: GrowthSurfaceObservation["entries"],
) =>
  compareGrowthSurfaces(
    {
      trustedBefore: { status: "available", value: observation(before) },
      candidateAfter: { status: "available", value: observation(after) },
    },
    fingerprint,
  );
export const decisionFor = (
  transitions: readonly GrowthTransition[],
  decisionId = "ADR-1",
): GrowthDecision => ({
  ...validDecision(),
  decisionId,
  transitions: transitions.map((x) => x.fingerprint),
  coordinates: transitions.map((x) => x.coordinate),
  changeFingerprint: growthGroupFingerprint(
    transitions.map((x) => x.fingerprint),
    fingerprint,
  ),
});
export const authorityFor = (decision: GrowthDecision) => ({
  decisionId: decision.decisionId,
  ownerRef: decision.ownerRef,
  decisionDigest: growthDecisionDigest(decision, fingerprint),
});
export const evaluate = (
  comparison: GrowthComparison,
  decisions: readonly unknown[] = [],
  changes: Partial<Parameters<typeof evaluateGrowthAdmission>[0]> = {},
) =>
  evaluateGrowthAdmission(
    {
      comparison,
      decisions,
      authority: [
        ...new Map(
          decisions.filter(isGrowthDecision).map((d) => [d.decisionId, authorityFor(d)]),
        ).values(),
      ],
      compatibility: "complete",
      ...changes,
    },
    fingerprint,
  );
export const codes = (result: GrowthAdmissionResult) => result.diagnostics.map((x) => x.code);

export function registerGrowthDecisionMetadataCases() {
  test("closed metadata accepts supported ordinary decisions without removal dates", () =>
    assert.equal(isGrowthDecision(valid()), true));
  const mutations: readonly (readonly [string, (value: Record<string, unknown>) => void])[] = [
    [
      "missing owner",
      (x) => {
        delete x.ownerRef;
      },
    ],
    [
      "empty owner",
      (x) => {
        x.ownerRef = " ";
      },
    ],
    [
      "duplicate transitions",
      (x) => {
        assert.ok(Array.isArray(x.transitions));
        x.transitions.push(digest);
      },
    ],
    [
      "malformed digest",
      (x) => {
        x.changeFingerprint = "bad";
      },
    ],
    [
      "unknown field",
      (x) => {
        x.approved = true;
      },
    ],
    [
      "missing consumer evidence",
      (x) => {
        x.consumerEvidenceRefs = [];
      },
    ],
    [
      "malformed coordinate",
      (x) => {
        assert.ok(Array.isArray(x.coordinates));
        x.coordinates[0].resolutionBranch = [{ index: -1 }];
      },
    ],
    [
      "missing migration conditions",
      (x) => {
        x.lifecycle = { kind: "removal" };
      },
    ],
    [
      "invented ordinary removal date",
      (x) => {
        assert.ok(typeof x.lifecycle === "object" && x.lifecycle !== null);
        Object.assign(x.lifecycle, { removalDate: "2030-01-01" }); // original malformed ordinary removal date
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    test(name, () => {
      const value = valid();
      mutate(value);
      assert.equal(isGrowthDecision(value), false);
    });
  }
}
export function registerGrowthDecisionComparisonCases() {
  test("addition without a decision rejects", () => {
    const result = evaluate(completeComparison([], [entry("A")]));
    assert.equal(result.status, "rejected");
    assert.deepEqual(codes(result), ["growth-transition-unadmitted"]);
  });
  test("exact decisions admit their transitions, leaving another addition unadmitted", () => {
    const comparison = completeComparison([], [entry("A"), entry("B")]);
    const decision = decisionFor(comparison.transitions.slice(0, 1));
    const partial = evaluate(comparison, [decision]);
    assert.equal(partial.status, "rejected");
    assert.equal(
      partial.diagnostics.find((x) => x.code === "growth-transition-unadmitted")?.subject,
      comparison.transitions[1]!.fingerprint,
    );
    const complete = evaluate(comparison, [
      decision,
      decisionFor(comparison.transitions.slice(1), "ADR-2"),
    ]);
    assert.equal(complete.status, "admitted");
    assert.equal(complete.admittedTransitions.length, 2);
    assert.equal(complete.releaseEligible, false);
  });
  const changedDigests: readonly (readonly [
    string,
    GrowthSurfaceObservation["entries"],
    GrowthSurfaceObservation["entries"],
  ])[] = [
    ["before", [entry("A", otherDigest)], [entry("A", otherDigest)]],
    ["after", [], [entry("A", otherDigest)]],
  ];
  for (const [label, before, after] of changedDigests) {
    test(`same decision ID cannot admit changed ${label} digest`, () => {
      const decision = decisionFor(completeComparison([], [entry("A")]).transitions);
      const result = evaluate(completeComparison(before, after), [decision]);
      assert.equal(result.status, "rejected");
      assert.ok(codes(result).includes("growth-decision-stale"));
    });
  }
  test("count-preserving rename is remove plus add", () => {
    const result = completeComparison([entry("A")], [entry("B")]);
    assert.equal(result.transitions.length, 2);
    assert.deepEqual(
      result.transitions.map((x) => [
        x.coordinate.subject.kind === "typed" ? x.coordinate.subject.canonicalReference : null,
        x.before.state,
        x.after.state,
      ]),
      [
        ["A", "present", "absent"],
        ["B", "absent", "present"],
      ],
    );
  });
  test("same symbol on two subpaths has distinct coordinates", () => {
    const result = completeComparison([], [entry("A"), entry("A", digest, "./extra")]);
    assert.equal(new Set(result.transitions.map((x) => x.fingerprint)).size, 2);
  });
  test("resolution target changes a value without changing the coordinate", () => {
    const branch: GrowthCoordinate = {
      ...coordinate(),
      resolutionBranch: [{ condition: "import" }],
      subject: { kind: "export-branch" },
    };
    const result = completeComparison(
      [{ coordinate: branch, value: { state: "present", digest } }],
      [{ coordinate: branch, value: { state: "present", digest: otherDigest } }],
    );
    assert.equal(result.transitions.length, 1);
    assert.deepEqual(result.transitions[0]!.coordinate, branch);
    assert.ok(result.transitions[0]!.before.state === "present");
    assert.equal(result.transitions[0]!.before.digest, digest);
    assert.ok(result.transitions[0]!.after.state === "present");
    assert.equal(result.transitions[0]!.after.digest, otherDigest);
  });
  test("policy version changes atomic and group identity", () => {
    const transition = completeComparison([], [entry("A")]).transitions[0]!;
    assert.notEqual(
      growthTransitionFingerprint(
        { ...transition, policyVersion: "foundation:sdk-growth:policy:2" },
        fingerprint,
      ),
      transition.fingerprint,
    );
    assert.notEqual(
      growthGroupFingerprint(
        [transition.fingerprint],
        fingerprint,
        "foundation:sdk-growth:policy:2",
      ),
      growthGroupFingerprint([transition.fingerprint], fingerprint),
    );
  });
  test("atomic payload matches independently specified canonical bytes", () => {
    const transition = completeComparison([], [entry("A")]).transitions[0]!;
    const bytes = `{"after":{"digest":"${digest}","state":"present"},"before":{"state":"absent"},"coordinate":{"exportPath":".","packageName":"example","resolutionBranch":[],"subject":{"canonicalReference":"A","kind":"typed"}},"domain":"foundation:sdk-growth:transition:1","policyVersion":"${policyVersion}"}`;
    assert.equal(transition.fingerprint, `sha256:${fingerprint.sha256(bytes)}`);
  });
  test("input order, source commit and decision metadata do not change transition identity", () => {
    const a = completeComparison([], [entry("A"), entry("B")]);
    const b = completeComparison([], [entry("B"), entry("A")]);
    assert.deepEqual(a, b);
    const decision = decisionFor(a.transitions);
    assert.equal(
      growthDecisionDigest(decision, fingerprint),
      growthDecisionDigest(
        {
          ...decision,
          coordinates: decision.coordinates.toReversed(),
          transitions: decision.transitions.toReversed(),
        },
        fingerprint,
      ),
    );
    const after = { ...observation([entry("A"), entry("B")]), sourceCommit: "c".repeat(40) };
    const changed = compareGrowthSurfaces(
      {
        trustedBefore: { status: "available", value: observation([]) },
        candidateAfter: { status: "available", value: after },
      },
      fingerprint,
    );
    assert.ok(changed.status === "complete");
    assert.deepEqual(a.transitions, changed.transitions);
    assert.notEqual(a.after, changed.after);
  });
  const decisionMutations: readonly (readonly [
    string,
    (decision: ReturnType<typeof decisionFor>) => unknown[],
    GrowthAdmissionResult["diagnostics"][number]["code"],
  ])[] = [
    ["duplicate ID", (d) => [d, d], "growth-decision-duplicate"],
    ["overlapping decisions", (d) => [d, { ...d, decisionId: "ADR-2" }], "growth-decision-overlap"],
    ["malformed metadata", (d) => [{ ...d, ownerRef: "" }], "growth-decision-malformed"],
    [
      "overbroad transition set",
      (d) => [{ ...d, transitions: [...d.transitions, otherDigest] }],
      "growth-decision-stale",
    ],
    [
      "underbroad coordinate set",
      (d) => [{ ...d, coordinates: d.coordinates.slice(0, 1) }],
      "growth-decision-coordinate-mismatch",
    ],
    [
      "mismatched group",
      (d) => [{ ...d, changeFingerprint: otherDigest }],
      "growth-decision-fingerprint-mismatch",
    ],
  ];
  for (const [label, mutate, code] of decisionMutations) {
    test(`${label} rejects`, () => {
      const c = completeComparison([], [entry("A"), entry("B")]),
        d = decisionFor(c.transitions);
      const result = evaluate(c, mutate(d));
      assert.equal(result.status, "rejected");
      assert.ok(codes(result).includes(code));
    });
  }
  test("decision bytes and accepted ID alone do not prove owner authority", () => {
    const c = completeComparison([], [entry("A")]),
      d = decisionFor(c.transitions);
    assert.equal(evaluate(c, [d], { authority: [] }).status, "incomplete");
    assert.equal(
      evaluate(c, [{ ...d, exposureRationale: "changed" }], { authority: [authorityFor(d)] })
        .status,
      "incomplete",
    );
  });
  test("admission cannot override release compatibility failure", () => {
    const c = completeComparison([], [entry("A")]);
    const result = evaluate(c, [decisionFor(c.transitions)], { compatibility: "rejected" });
    assert.equal(result.status, "rejected");
    assert.ok(codes(result).includes("growth-compatibility-rejected"));
    assert.deepEqual(result.admittedTransitions, []);
  });
  test("unavailable trusted input is incomplete, never an empty baseline", () => {
    const c = compareGrowthSurfaces(
      {
        trustedBefore: { status: "unavailable", reasons: ["shallow-history"] },
        candidateAfter: { status: "available", value: observation([entry("A")]) },
      },
      fingerprint,
    );
    assert.equal(c.status, "incomplete");
    assert.deepEqual(c.findings, []);
    assert.equal(evaluate(c).status, "incomplete");
  });
  test("limited coverage cannot prove absence or equality", () => {
    const original = observation([]);
    const before: GrowthSurfaceObservation = {
      ...original,
      coverage: original.coverage.map((row) => ({
        ...row,
        dimensions: row.dimensions.map((item) =>
          item.dimension === "typed" ? { ...item, status: "limited" } : item,
        ),
      })),
    };
    const c = compareGrowthSurfaces(
      {
        trustedBefore: { status: "available", value: normalizeGrowthObservation(before) },
        candidateAfter: { status: "available", value: observation([entry("A")]) },
      },
      fingerprint,
    );
    assert.equal(c.status, "incomplete");
    assert.deepEqual(c.findings, []);
  });
  test("duplicate observation coordinates and no-change atomic claims are invalid", () => {
    assert.throws(() => completeComparison([], [entry("A"), entry("A")]), /duplicate/u);
    assert.throws(
      () =>
        growthTransitionFingerprint(
          {
            coordinate: coordinate(),
            before: { state: "absent" },
            after: { state: "absent" },
            policyVersion,
          },
          fingerprint,
        ),
      /no-change/u,
    );
  });
}
